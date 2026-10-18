// Slotboard API: a Cloudflare Worker in front of a D1 database.
// The website (on GitHub Pages) calls POST /rpc/<action> with a JSON body.
// Organizer actions check the master code (stored as a PBKDF2 hash) first;
// invitee actions never return contact info, codes or edit keys.

import { env } from "cloudflare:workers";

type Json = Record<string, any>;
const db = () => (env as any).DB as D1Database;

// ---------- schema (created on first request) ----------

let schemaReady: Promise<unknown> | null = null;
function ensureSchema() {
	schemaReady ??= db().batch([
		db().prepare(`CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY, invite TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL,
			title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
			date_text TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '',
			show_names INTEGER NOT NULL DEFAULT 1, closed INTEGER NOT NULL DEFAULT 0,
			failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
			created_at TEXT NOT NULL)`),
		db().prepare(`CREATE TABLE IF NOT EXISTS slots (
			id TEXT PRIMARY KEY, event_id TEXT NOT NULL, position INTEGER NOT NULL,
			label TEXT NOT NULL, when_text TEXT NOT NULL DEFAULT '', capacity INTEGER NOT NULL)`),
		db().prepare(`CREATE INDEX IF NOT EXISTS slots_event_idx ON slots(event_id)`),
		db().prepare(`CREATE TABLE IF NOT EXISTS signups (
			id TEXT PRIMARY KEY, slot_id TEXT NOT NULL, name TEXT NOT NULL,
			contact TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
			edit_key TEXT NOT NULL, created_at TEXT NOT NULL)`),
		db().prepare(`CREATE INDEX IF NOT EXISTS signups_slot_idx ON signups(slot_id)`),
	]).catch(err => { schemaReady = null; throw err; });
	return schemaReady;
}

// ---------- helpers ----------

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function token(len: number) {
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let out = "";
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
	return out;
}
function masterCode() {
	return token(12).toUpperCase().match(/.{4}/g)!.join("-");
}
function clean(v: unknown, max: number) {
	return String(v ?? "").trim().slice(0, max);
}
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map(x => parseInt(x, 16)));

const ITERATIONS = 100000; // the most PBKDF2 rounds Workers allow
async function pbkdf2(code: string, salt: Uint8Array, iterations: number) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
async function hashCode(code: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2$${ITERATIONS}$${hex(salt)}$${hex(await pbkdf2(code.trim(), salt, ITERATIONS))}`;
}
async function codeMatches(code: string, stored: string) {
	const [, iters, salt, want] = stored.split("$");
	const got = await pbkdf2(code.trim(), unhex(salt), Number(iters));
	const exp = unhex(want);
	if (got.length !== exp.length) return false;
	let diff = 0;
	for (let i = 0; i < got.length; i++) diff |= got[i] ^ exp[i];
	return diff === 0;
}

const err = (message: string) => ({ error: message });
const BAD_CODE = "That event code and master code do not match.";
const BAD_INVITE = "This invite link is not valid. Ask the organizer for a new one.";

function validSlots(slots: unknown) {
	return Array.isArray(slots) ? slots.slice(0, 200).filter((s: any) => clean(s?.label, 120) !== "") : [];
}

// Replace an event's slots. Slots that keep their id keep their sign-ups.
async function setSlots(eventId: string, slots: any[]) {
	const existing = new Set(
		(await db().prepare("SELECT id FROM slots WHERE event_id = ?").bind(eventId).all()).results.map((r: any) => r.id),
	);
	const keep = new Set<string>();
	const stmts: D1PreparedStatement[] = [];
	slots.forEach((s, i) => {
		const capacity = Math.max(1, Math.min(999, parseInt(String(s.capacity), 10) || 1));
		const label = clean(s.label, 120), when = clean(s.when, 80);
		if (s.id && existing.has(s.id) && !keep.has(s.id)) {
			keep.add(s.id);
			stmts.push(db().prepare("UPDATE slots SET position = ?, label = ?, when_text = ?, capacity = ? WHERE id = ?")
				.bind(i + 1, label, when, capacity, s.id));
		} else {
			const id = token(8);
			keep.add(id);
			stmts.push(db().prepare("INSERT INTO slots (id, event_id, position, label, when_text, capacity) VALUES (?, ?, ?, ?, ?, ?)")
				.bind(id, eventId, i + 1, label, when, capacity));
		}
	});
	for (const id of existing) {
		if (keep.has(id)) continue;
		stmts.push(db().prepare("DELETE FROM signups WHERE slot_id = ?").bind(id));
		stmts.push(db().prepare("DELETE FROM slots WHERE id = ?").bind(id));
	}
	if (stmts.length) await db().batch(stmts);
}

async function loadSlots(eventId: string) {
	const [slots, signups] = await db().batch([
		db().prepare("SELECT * FROM slots WHERE event_id = ? ORDER BY position").bind(eventId),
		db().prepare(`SELECT g.* FROM signups g JOIN slots s ON s.id = g.slot_id
			WHERE s.event_id = ? ORDER BY g.created_at`).bind(eventId),
	]);
	return { slots: slots.results as any[], signups: signups.results as any[] };
}

async function managerView(id: string) {
	const ev: any = await db().prepare("SELECT * FROM events WHERE id = ?").bind(id).first();
	if (!ev) return err(BAD_CODE);
	const { slots, signups } = await loadSlots(id);
	return {
		id: ev.id, invite: ev.invite, title: ev.title, description: ev.description, location: ev.location,
		date: ev.date_text, host: ev.host, showNames: !!ev.show_names, closed: !!ev.closed, createdAt: ev.created_at,
		slots: slots.map(s => ({
			id: s.id, label: s.label, when: s.when_text, capacity: s.capacity,
			signups: signups.filter(g => g.slot_id === s.id)
				.map(g => ({ id: g.id, name: g.name, contact: g.contact, note: g.note, at: g.created_at })),
		})),
	};
}

// Returns an error message, or null when the master code is right.
// Ten wrong codes lock that event's dashboard for 15 minutes.
async function checkCode(id: unknown, code: unknown) {
	const ev: any = await db().prepare("SELECT id, code_hash, failed_attempts, locked_until FROM events WHERE id = ?")
		.bind(String(id ?? "")).first();
	if (!ev) return BAD_CODE;
	const now = Date.now();
	if (ev.locked_until && ev.locked_until > now) return "Too many wrong codes for this event. Wait 15 minutes and try again.";
	if (!clean(code, 200) || !(await codeMatches(String(code), ev.code_hash))) {
		const tries = ev.locked_until ? 1 : ev.failed_attempts + 1;
		await db().prepare("UPDATE events SET failed_attempts = ?, locked_until = ? WHERE id = ?")
			.bind(tries, tries >= 10 ? now + 15 * 60 * 1000 : null, ev.id).run();
		return BAD_CODE;
	}
	if (ev.failed_attempts || ev.locked_until) {
		await db().prepare("UPDATE events SET failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(ev.id).run();
	}
	return null;
}

// ---------- actions ----------

const actions: Record<string, (a: Json) => Promise<Json>> = {
	async create_event({ p = {} }) {
		const title = clean(p.title, 120);
		if (!title) return err("Give the event a title.");
		let code = clean(p.masterCode, 80);
		if (code && code.length < 6) return err("A custom master code needs at least 6 characters.");
		const slots = validSlots(p.slots);
		if (!slots.length) return err("Add at least one slot people can sign up for.");
		if (!code) code = masterCode();
		const id = token(10), invite = token(10);
		await db().prepare(`INSERT INTO events (id, invite, code_hash, title, description, location, date_text, host, show_names, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(id, invite, await hashCode(code), title, clean(p.description, 2000), clean(p.location, 200),
				clean(p.date, 80), clean(p.host, 80), p.showNames === false ? 0 : 1, new Date().toISOString())
			.run();
		await setSlots(id, slots);
		return { id, invite, masterCode: code };
	},

	async get_invite({ p_invite }) {
		const ev: any = await db().prepare("SELECT * FROM events WHERE invite = ?").bind(String(p_invite ?? "")).first();
		if (!ev) return err(BAD_INVITE);
		const { slots, signups } = await loadSlots(ev.id);
		return {
			title: ev.title, description: ev.description, location: ev.location, date: ev.date_text, host: ev.host,
			showNames: !!ev.show_names, closed: !!ev.closed,
			slots: slots.map(s => {
				const mine = signups.filter(g => g.slot_id === s.id);
				return { id: s.id, label: s.label, when: s.when_text, capacity: s.capacity, taken: mine.length,
					names: ev.show_names ? mine.map(g => g.name) : [] };
			}),
		};
	},

	async sign_up({ p_invite, p_slot, p_name, p_contact, p_note }) {
		const ev: any = await db().prepare("SELECT id, closed FROM events WHERE invite = ?").bind(String(p_invite ?? "")).first();
		if (!ev) return err(BAD_INVITE);
		if (ev.closed) return err("The organizer has closed sign-ups.");
		const name = clean(p_name, 80);
		if (!name) return err("Enter your name to sign up.");
		const id = token(8), editKey = token(16), slotId = String(p_slot ?? "");
		// One statement, so two people can't both take the last spot.
		const res = await db().prepare(`INSERT INTO signups (id, slot_id, name, contact, note, edit_key, created_at)
			SELECT ?, s.id, ?, ?, ?, ?, ? FROM slots s
			WHERE s.id = ? AND s.event_id = ? AND (SELECT count(*) FROM signups WHERE slot_id = s.id) < s.capacity`)
			.bind(id, name, clean(p_contact, 120), clean(p_note, 300), editKey, new Date().toISOString(), slotId, ev.id)
			.run();
		if (!res.meta.changes) {
			const exists = await db().prepare("SELECT 1 FROM slots WHERE id = ? AND event_id = ?").bind(slotId, ev.id).first();
			return err(exists ? "That slot just filled up. Pick another one." : "That slot no longer exists.");
		}
		return { signupId: id, slotId, editKey };
	},

	async cancel_signup({ p_invite, p_signup, p_key }) {
		const res = await db().prepare(`DELETE FROM signups WHERE id = ? AND edit_key = ? AND slot_id IN
			(SELECT s.id FROM slots s JOIN events e ON e.id = s.event_id WHERE e.invite = ?)`)
			.bind(String(p_signup ?? ""), String(p_key ?? ""), String(p_invite ?? "")).run();
		return res.meta.changes ? { ok: true } : err("That sign-up was not found. It may already be cancelled.");
	},

	async manage_get({ p_id, p_code }) {
		const e = await checkCode(p_id, p_code);
		return e ? err(e) : managerView(p_id);
	},

	async manage_update({ p_id, p_code, p = {} }) {
		const e = await checkCode(p_id, p_code);
		if (e) return err(e);
		if ("slots" in p && !validSlots(p.slots).length) return err("Keep at least one slot.");
		const sets: string[] = [], vals: unknown[] = [];
		const field = (col: string, val: unknown) => { sets.push(`${col} = ?`); vals.push(val); };
		if (clean(p.title, 120)) field("title", clean(p.title, 120));
		if ("description" in p) field("description", clean(p.description, 2000));
		if ("location" in p) field("location", clean(p.location, 200));
		if ("date" in p) field("date_text", clean(p.date, 80));
		if ("host" in p) field("host", clean(p.host, 80));
		if ("showNames" in p) field("show_names", p.showNames ? 1 : 0);
		if ("closed" in p) field("closed", p.closed ? 1 : 0);
		if (sets.length) await db().prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, p_id).run();
		if ("slots" in p) await setSlots(p_id, validSlots(p.slots));
		return managerView(p_id);
	},

	async manage_remove({ p_id, p_code, p_signup }) {
		const e = await checkCode(p_id, p_code);
		if (e) return err(e);
		const res = await db().prepare("DELETE FROM signups WHERE id = ? AND slot_id IN (SELECT id FROM slots WHERE event_id = ?)")
			.bind(String(p_signup ?? ""), p_id).run();
		return res.meta.changes ? managerView(p_id) : err("That sign-up was not found.");
	},

	async manage_new_invite({ p_id, p_code }) {
		const e = await checkCode(p_id, p_code);
		if (e) return err(e);
		await db().prepare("UPDATE events SET invite = ? WHERE id = ?").bind(token(10), p_id).run();
		return managerView(p_id);
	},

	async manage_new_code({ p_id, p_code, p_new }) {
		const e = await checkCode(p_id, p_code);
		if (e) return err(e);
		let code = clean(p_new, 80);
		if (code && code.length < 6) return err("A custom master code needs at least 6 characters.");
		if (!code) code = masterCode();
		await db().prepare("UPDATE events SET code_hash = ? WHERE id = ?").bind(await hashCode(code), p_id).run();
		return { masterCode: code };
	},

	async manage_delete({ p_id, p_code }) {
		const e = await checkCode(p_id, p_code);
		if (e) return err(e);
		await db().batch([
			db().prepare("DELETE FROM signups WHERE slot_id IN (SELECT id FROM slots WHERE event_id = ?)").bind(p_id),
			db().prepare("DELETE FROM slots WHERE event_id = ?").bind(p_id),
			db().prepare("DELETE FROM events WHERE id = ?").bind(p_id),
		]);
		return { ok: true };
	},
};

// ---------- HTTP ----------

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Max-Age": "86400",
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
		if (url.pathname === "/" && request.method === "GET") return json({ ok: true, service: "Slotboard API" });

		// Always read the body, even for requests we reject, so the connection stays usable.
		const text = await request.text();
		const m = url.pathname.match(/^\/rpc\/(\w+)$/);
		const action = m && Object.hasOwn(actions, m[1]) ? actions[m[1]] : null;
		if (!action || request.method !== "POST") return json({ error: "Not found." }, 404);

		if (text.length > 200 * 1024) return json({ error: "That request is too large." }, 413);
		let args: Json;
		try { args = text ? JSON.parse(text) : {}; } catch { return json({ error: "That request could not be read." }, 400); }
		if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
		if (args.p && typeof args.p !== "object") args.p = {};

		try {
			await ensureSchema();
			return json(await action(args));
		} catch (e) {
			console.error(m![1], e);
			return json({ error: "Something went wrong on the server. Try again." }, 500);
		}
	},
} satisfies ExportedHandler;
