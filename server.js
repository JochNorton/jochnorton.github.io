// Slotboard — a sign-up sheet site with no accounts.
// The organizer holds a master code; everyone else gets an invite link
// that lets them sign up (and cancel their own sign-up) but never edit the event.
// Zero dependencies: run with `node server.js`.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- storage ----------

let db = { events: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!db.events) db.events = {};
} catch (_) { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 50);
}

// ---------- helpers ----------

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function token(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Human-friendly master code, e.g. "KQ7M-P3XA-9TRW"
function masterCode() {
  return token(12).toUpperCase().match(/.{4}/g).join('-');
}

function normalizeCode(code) {
  return String(code || '').trim();
}

function hashCode(code, salt) {
  return crypto.scryptSync(normalizeCode(code), salt, 32).toString('hex');
}

function checkCode(event, code) {
  if (!code) return false;
  const a = Buffer.from(hashCode(code, event.salt), 'hex');
  const b = Buffer.from(event.codeHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clean(str, max) {
  return String(str == null ? '' : str).trim().slice(0, max);
}

function cleanSlots(slots, existing) {
  if (!Array.isArray(slots)) return [];
  const byId = new Map((existing || []).map(s => [s.id, s]));
  return slots.slice(0, 200).map(s => {
    const prev = byId.get(s.id);
    const capacity = Math.max(1, Math.min(999, parseInt(s.capacity, 10) || 1));
    return {
      id: prev ? prev.id : token(8),
      label: clean(s.label, 120) || 'Untitled slot',
      when: clean(s.when, 80),
      capacity,
      signups: prev ? prev.signups : [],
    };
  });
}

// Strip anything secret before sending an event to an invitee.
function publicView(ev) {
  return {
    title: ev.title,
    description: ev.description,
    location: ev.location,
    date: ev.date,
    host: ev.host,
    showNames: ev.showNames,
    closed: ev.closed,
    slots: ev.slots.map(s => ({
      id: s.id,
      label: s.label,
      when: s.when,
      capacity: s.capacity,
      taken: s.signups.length,
      names: ev.showNames ? s.signups.map(x => x.name) : [],
    })),
  };
}

function managerView(ev) {
  return {
    id: ev.id,
    invite: ev.invite,
    title: ev.title,
    description: ev.description,
    location: ev.location,
    date: ev.date,
    host: ev.host,
    showNames: ev.showNames,
    closed: ev.closed,
    createdAt: ev.createdAt,
    slots: ev.slots.map(s => ({
      id: s.id,
      label: s.label,
      when: s.when,
      capacity: s.capacity,
      signups: s.signups.map(x => ({ id: x.id, name: x.name, contact: x.contact, note: x.note, at: x.at })),
    })),
  };
}

function findByInvite(invite) {
  return Object.values(db.events).find(e => e.invite === invite);
}

// Very small brute-force guard on master code attempts.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++;
  attempts.set(ip, rec);
  return rec.n > 30;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 200 * 1024) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// ---------- API ----------

async function api(req, res, parts) {
  const method = req.method;
  // Hosts like Render put the visitor's real IP first in X-Forwarded-For.
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  let body = {};
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    try { body = await readBody(req); }
    catch (_) { return send(res, 400, { error: 'That request could not be read.' }); }
  }

  // POST /api/events — create
  if (parts.length === 1 && parts[0] === 'events' && method === 'POST') {
    const title = clean(body.title, 120);
    if (!title) return send(res, 400, { error: 'Give the event a title.' });
    let code = normalizeCode(body.masterCode);
    if (code && code.length < 6) return send(res, 400, { error: 'A custom master code needs at least 6 characters.' });
    if (!code) code = masterCode();

    const salt = crypto.randomBytes(16).toString('hex');
    const ev = {
      id: token(10),
      invite: token(10),
      title,
      description: clean(body.description, 2000),
      location: clean(body.location, 200),
      date: clean(body.date, 80),
      host: clean(body.host, 80),
      showNames: body.showNames !== false,
      closed: false,
      salt,
      codeHash: hashCode(code, salt),
      createdAt: new Date().toISOString(),
      slots: [],
    };
    ev.slots = cleanSlots(body.slots, []);
    if (!ev.slots.length) return send(res, 400, { error: 'Add at least one slot people can sign up for.' });
    db.events[ev.id] = ev;
    save();
    return send(res, 201, { id: ev.id, invite: ev.invite, masterCode: code });
  }

  // Invitee routes: /api/invite/:invite ...
  if (parts[0] === 'invite' && parts[1]) {
    const ev = findByInvite(parts[1]);
    if (!ev) return send(res, 404, { error: 'This invite link is not valid. Ask the organizer for a new one.' });

    if (parts.length === 2 && method === 'GET') return send(res, 200, publicView(ev));

    // POST /api/invite/:invite/signup
    if (parts[2] === 'signup' && method === 'POST') {
      if (ev.closed) return send(res, 403, { error: 'The organizer has closed sign-ups.' });
      const slot = ev.slots.find(s => s.id === body.slotId);
      if (!slot) return send(res, 404, { error: 'That slot no longer exists.' });
      const name = clean(body.name, 80);
      if (!name) return send(res, 400, { error: 'Enter your name to sign up.' });
      if (slot.signups.length >= slot.capacity) return send(res, 409, { error: 'That slot just filled up. Pick another one.' });
      const editKey = token(16);
      const signup = {
        id: token(8),
        name,
        contact: clean(body.contact, 120),
        note: clean(body.note, 300),
        at: new Date().toISOString(),
        editKey,
      };
      slot.signups.push(signup);
      save();
      return send(res, 201, { signupId: signup.id, slotId: slot.id, editKey });
    }

    // DELETE /api/invite/:invite/signup — cancel your own (needs the editKey you were given)
    if (parts[2] === 'signup' && method === 'DELETE') {
      for (const slot of ev.slots) {
        const i = slot.signups.findIndex(s => s.id === body.signupId && s.editKey === body.editKey);
        if (i !== -1) {
          slot.signups.splice(i, 1);
          save();
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'That sign-up was not found. It may already be cancelled.' });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  // Organizer routes: /api/manage/:id ... (master code in the X-Master-Code header)
  if (parts[0] === 'manage' && parts[1]) {
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
    const ev = db.events[parts[1]];
    const code = req.headers['x-master-code'];
    if (!ev || !checkCode(ev, code)) return send(res, 403, { error: 'That event code and master code do not match.' });
    attempts.delete(ip);

    if (parts.length === 2 && method === 'GET') return send(res, 200, managerView(ev));

    // PUT /api/manage/:id — edit details and slots
    if (parts.length === 2 && method === 'PUT') {
      if ('title' in body) ev.title = clean(body.title, 120) || ev.title;
      if ('description' in body) ev.description = clean(body.description, 2000);
      if ('location' in body) ev.location = clean(body.location, 200);
      if ('date' in body) ev.date = clean(body.date, 80);
      if ('host' in body) ev.host = clean(body.host, 80);
      if ('showNames' in body) ev.showNames = !!body.showNames;
      if ('closed' in body) ev.closed = !!body.closed;
      if ('slots' in body) {
        const next = cleanSlots(body.slots, ev.slots);
        if (!next.length) return send(res, 400, { error: 'Keep at least one slot.' });
        ev.slots = next;
      }
      save();
      return send(res, 200, managerView(ev));
    }

    // DELETE /api/manage/:id — delete the whole event
    if (parts.length === 2 && method === 'DELETE') {
      delete db.events[ev.id];
      save();
      return send(res, 200, { ok: true });
    }

    // POST /api/manage/:id/remove — remove someone's sign-up
    if (parts[2] === 'remove' && method === 'POST') {
      for (const slot of ev.slots) {
        const i = slot.signups.findIndex(s => s.id === body.signupId);
        if (i !== -1) { slot.signups.splice(i, 1); save(); return send(res, 200, managerView(ev)); }
      }
      return send(res, 404, { error: 'That sign-up was not found.' });
    }

    // POST /api/manage/:id/new-invite — revoke the old invite link
    if (parts[2] === 'new-invite' && method === 'POST') {
      ev.invite = token(10);
      save();
      return send(res, 200, managerView(ev));
    }

    // POST /api/manage/:id/new-code — change the master code
    if (parts[2] === 'new-code' && method === 'POST') {
      let next = normalizeCode(body.masterCode);
      if (next && next.length < 6) return send(res, 400, { error: 'A custom master code needs at least 6 characters.' });
      if (!next) next = masterCode();
      ev.salt = crypto.randomBytes(16).toString('hex');
      ev.codeHash = hashCode(next, ev.salt);
      save();
      return send(res, 200, { masterCode: next });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  return send(res, 404, { error: 'Not found.' });
}

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, urlPath) {
  let file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    // App routes (/, /e/xyz, /manage/xyz) all load the single page.
    if (err || !st.isFile()) file = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(file, (err2, buf) => {
      if (err2) { res.writeHead(500); return res.end('Server error'); }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    });
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'api') {
    api(req, res, parts.slice(1)).catch(err => {
      console.error(err);
      send(res, 500, { error: 'Something went wrong on the server.' });
    });
    return;
  }
  serveStatic(req, res, decodeURIComponent(url.pathname));
}).listen(PORT, () => {
  console.log(`Slotboard running at http://localhost:${PORT}`);
});
