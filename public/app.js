// Slotboard front end. Three views:
//   /                 create a sheet, or open one you manage
//   /e/<invite>       invitees sign up (read-only event)
//   /manage/<id>#code organizer dashboard (needs the master code)

const app = document.getElementById('app');
const ORIGIN = location.origin;

// ---------- tiny helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(method, url, body, code) {
  const headers = { 'Content-Type': 'application/json' };
  if (code) headers['X-Master-Code'] = code;
  const res = await fetch('/api' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

async function copy(text, el) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (_) {
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    toast('Press Ctrl+C to copy');
  }
}

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (_) {} },
};

const inviteUrl = inv => `${ORIGIN}/e/${inv}`;
const masterUrl = (id, code) => `${ORIGIN}/manage/${id}#${encodeURIComponent(code)}`;

function errorBox() { const e = h('div', { class: 'error', hidden: true }); e.show = m => { e.textContent = m; e.hidden = !m; }; return e; }

function seats(taken, cap) {
  const max = Math.min(cap, 24);
  const boxes = [];
  for (let i = 0; i < max; i++) boxes.push(h('span', { class: 'seat' + (i < taken ? ' on' : '') }));
  return h('div', { class: 'seats', 'aria-label': `${taken} of ${cap} spots taken` },
    boxes, h('span', { class: 'seat-count', text: `${taken}/${cap}` }));
}

function linkBox(label, url, opts = {}) {
  const u = h('div', { class: 'url', text: url });
  return h('div', { class: 'linkbox' + (opts.master ? ' master' : '') },
    h('span', { class: 'badge' + (opts.master ? ' key' : ''), text: label }),
    u,
    opts.note ? h('p', { class: 'warn', text: opts.note }) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => copy(url, u) }, 'Copy link'),
      opts.open ? h('a', { class: 'btn small ghost', href: url }, 'Open') : null));
}

// ---------- slot editor (shared by create + manage) ----------

function slotEditor(initial) {
  const list = h('div', { class: 'slot-editor' });
  const head = h('div', { class: 'slot-edit-row slot-edit-head' },
    h('span', { text: 'What people sign up for' }), h('span', { text: 'When (optional)' }), h('span', { text: 'Spots' }), h('span'));
  list.append(head);
  const rows = [];

  function addRow(s = {}) {
    const label = h('input', { type: 'text', placeholder: 'e.g. Bring drinks', maxlength: 120, 'aria-label': 'Slot name' });
    label.value = s.label || '';
    const when = h('input', { type: 'text', class: 'when-in', placeholder: 'e.g. Sat 10–11am', maxlength: 80, 'aria-label': 'Time' });
    when.value = s.when || '';
    const cap = h('input', { type: 'number', min: 1, max: 999, 'aria-label': 'Number of spots' });
    cap.value = s.capacity || 1;
    const row = h('div', { class: 'slot-edit-row' }, label, when, cap);
    const entry = { id: s.id, label, when, cap, row, taken: (s.signups || []).length };
    const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove slot', title: 'Remove slot',
      onclick: () => { rows.splice(rows.indexOf(entry), 1); row.remove(); } }, '×');
    row.append(del);
    rows.push(entry);
    list.append(row);
    return entry;
  }

  (initial && initial.length ? initial : [{}, {}, {}]).forEach(addRow);
  const add = h('button', { class: 'btn small ghost', type: 'button', onclick: () => addRow().label.focus() }, '+ Add a slot');
  const wrap = h('div', { class: 'slot-editor' }, list, h('div', { class: 'row' }, add));
  wrap.value = () => rows
    .filter(r => r.label.value.trim())
    .map(r => ({ id: r.id, label: r.label.value.trim(), when: r.when.value.trim(), capacity: parseInt(r.cap.value, 10) || 1 }));
  return wrap;
}

// ---------- home ----------

function viewHome() {
  document.title = 'Slotboard';
  const err = errorBox();
  const title = h('input', { type: 'text', id: 'c-title', required: true, maxlength: 120, placeholder: 'Spring bake sale volunteers' });
  const date = h('input', { type: 'text', id: 'c-date', maxlength: 80, placeholder: 'Saturday, May 9' });
  const location = h('input', { type: 'text', id: 'c-loc', maxlength: 200, placeholder: 'Lincoln Elementary gym' });
  const host = h('input', { type: 'text', id: 'c-host', maxlength: 80, placeholder: 'Ms. Rivera' });
  const desc = h('textarea', { id: 'c-desc', maxlength: 2000, placeholder: 'Anything people should know before signing up.' });
  const custom = h('input', { type: 'text', id: 'c-code', maxlength: 80, placeholder: 'Leave blank to generate one', autocomplete: 'off' });
  const showNames = h('input', { type: 'checkbox', id: 'c-show', checked: true });
  const slots = slotEditor();
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Create sheet and get links');

  const form = h('form', { class: 'sheet', id: 'create', onsubmit: async e => {
    e.preventDefault();
    err.show('');
    submit.disabled = true;
    try {
      const res = await api('POST', '/events', {
        title: title.value, date: date.value, location: location.value, host: host.value,
        description: desc.value, masterCode: custom.value, showNames: showNames.checked, slots: slots.value(),
      });
      session.set('code:' + res.id, res.masterCode);
      viewCreated(res, title.value.trim());
    } catch (x) { err.show(x.message); submit.disabled = false; }
  } },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow', text: 'New sign-up sheet' }), h('h2', { text: 'Set up your event' })),
    h('div', { class: 'fields' },
      h('label', { class: 'field full' }, 'Event title', title),
      h('label', { class: 'field' }, 'Date', date),
      h('label', { class: 'field' }, 'Location (optional)', location),
      h('label', { class: 'field' }, 'Organizer name', host),
      h('label', { class: 'field' }, h('span', {}, 'Master code ', h('small', { text: '(min. 6 characters)' })), custom),
      h('label', { class: 'field full' }, 'Details', desc)),
    h('div', { class: 'sheet-head' }, h('h3', { text: 'Slots' }), h('p', { class: 'muted', text: 'Each slot is a job, item, or time people can claim. Spots is how many people can take it.' })),
    slots,
    h('label', { class: 'check' }, showNames, h('span', {}, 'Let people see who already signed up for each slot')),
    err,
    h('div', { class: 'row' }, submit));

  const mErr = errorBox();
  const mId = h('input', { type: 'text', id: 'm-id', placeholder: 'Event code or master link', autocomplete: 'off' });
  const mCode = h('input', { type: 'password', id: 'm-code', placeholder: 'Master code', autocomplete: 'off' });
  const manage = h('form', { class: 'sheet', id: 'manage', onsubmit: e => {
    e.preventDefault();
    let id = mId.value.trim(), code = mCode.value.trim();
    const m = id.match(/manage\/([a-z0-9]+)(?:#(.+))?/i);
    if (m) { id = m[1]; if (m[2] && !code) code = decodeURIComponent(m[2]); }
    if (!id || !code) return mErr.show('Enter the event code and the master code.');
    session.set('code:' + id, code);
    go('/manage/' + id);
  } },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow', text: 'Organizers' }), h('h2', { text: 'Manage a sheet' }),
      h('p', { class: 'muted', text: 'Paste your master link, or enter the event code and master code you saved.' })),
    h('label', { class: 'field' }, 'Event code or master link', mId),
    h('label', { class: 'field' }, 'Master code', mCode),
    mErr,
    h('button', { class: 'btn ghost', type: 'submit' }, 'Open dashboard'));

  app.replaceChildren(
    h('section', { class: 'hero' },
      h('span', { class: 'eyebrow', text: 'Sign-up sheets, no accounts' }),
      h('h1', {}, 'One ', h('mark', { text: 'master code' }), ' runs the sheet. Everyone else just signs up.'),
      h('p', { class: 'lede', text: 'Create an event and you get two links: a master link only you keep, and an invite link you share. People with the invite can claim a slot and cancel their own, but they can’t change the event.' })),
    h('section', { class: 'how' },
      h('div', {}, h('b', { text: 'Create' }), h('span', { text: 'Add your slots, times and how many people each needs.' })),
      h('div', {}, h('b', { text: 'Keep the master code' }), h('span', { text: 'It is the only key to edit, close, or delete the sheet. Save it somewhere safe.' })),
      h('div', {}, h('b', { text: 'Share the invite' }), h('span', { text: 'Text or email it. Anyone with it can sign up. Revoke it anytime.' }))),
    h('section', { class: 'split' }, form, manage));

  if (location.hash === '#manage') mId.focus();
}

function viewCreated(res, title) {
  history.pushState({}, '', '/');
  const code = h('span', { class: 'code', text: res.masterCode });
  app.replaceChildren(h('section', { class: 'sheet' },
    h('div', { class: 'sheet-head' },
      h('span', { class: 'eyebrow', text: 'Sheet created' }),
      h('h1', { text: title }),
      h('p', { class: 'lede', text: 'Save the master code now. It is stored scrambled, so nobody can look it up for you later.' })),
    h('div', { class: 'linkbox master' },
      h('span', { class: 'badge key', text: 'Master code — keep private' }),
      h('div', { class: 'row' }, code, h('button', { class: 'btn small', type: 'button', onclick: () => copy(res.masterCode, code) }, 'Copy code')),
      h('p', { class: 'warn' }, 'Event code: ', h('b', { text: res.id }), '. Use both on the Manage page if you lose the master link.')),
    linkBox('Master link — keep private', masterUrl(res.id, res.masterCode), { master: true, note: 'Opens your organizer dashboard. Don’t share it: anyone with it can edit the sheet.' }),
    linkBox('Invite link — share this', inviteUrl(res.invite), { open: true, note: 'People with this link can sign up and cancel their own spot only.' }),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '/manage/' + res.id }, 'Go to organizer dashboard'))));
  window.scrollTo(0, 0);
}

// ---------- invitee view ----------

async function viewInvite(invite) {
  app.replaceChildren(h('p', { class: 'muted', text: 'Loading sign-up sheet…' }));
  let ev;
  try { ev = await api('GET', '/invite/' + invite); }
  catch (x) {
    app.replaceChildren(h('section', { class: 'sheet center' }, h('h2', { text: 'Link not working' }), h('p', { class: 'muted', text: x.message }), h('a', { class: 'btn ghost', href: '/' }, 'Go to Slotboard')));
    return;
  }
  document.title = ev.title + ' · Slotboard';
  const key = 'mine:' + invite;
  let mine = store.get(key, []);
  // forget sign-ups that the organizer removed or whose slot is gone
  const slotIds = new Set(ev.slots.map(s => s.id));
  mine = mine.filter(m => slotIds.has(m.slotId));

  let openSlot = null;
  const list = h('div', { class: 'slots' });

  function render() {
    list.replaceChildren(...ev.slots.map(s => {
      const full = s.taken >= s.capacity;
      const myOnes = mine.filter(m => m.slotId === s.id);
      const row = h('div', { class: 'slot' + (full ? ' full' : '') });
      const main = h('div', { class: 'slot-main' },
        h('span', { class: 'slot-label', text: s.label }),
        s.when ? h('span', { class: 'slot-when', text: s.when }) : null,
        seats(s.taken, s.capacity),
        ev.showNames && s.names.length ? h('span', { class: 'names', text: s.names.join(', ') }) : null,
        myOnes.map(m => h('span', { class: 'row' },
          h('span', { class: 'mine', text: `✓ You signed up as ${m.name}` }),
          h('button', { class: 'btn link', type: 'button', onclick: () => cancel(m) }, 'Cancel'))));
      let action;
      if (ev.closed) action = h('span', { class: 'badge closed', text: 'Closed' });
      else if (full) action = h('span', { class: 'badge', text: 'Full' });
      else action = h('button', { class: 'btn small', type: 'button', onclick: () => { openSlot = openSlot === s.id ? null : s.id; render(); } }, openSlot === s.id ? 'Close' : 'Sign up');
      row.append(main, action);
      if (openSlot === s.id && !full && !ev.closed) row.append(signupForm(s));
      return row;
    }));
  }

  function signupForm(s) {
    const err = errorBox();
    const name = h('input', { type: 'text', id: 's-name', maxlength: 80, required: true, autocomplete: 'name' });
    name.value = store.get('lastName', '');
    const contact = h('input', { type: 'text', id: 's-contact', maxlength: 120, autocomplete: 'off' });
    const note = h('input', { type: 'text', id: 's-note', maxlength: 300 });
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Confirm sign-up');
    const f = h('form', { class: 'slot-form', onsubmit: async e => {
      e.preventDefault();
      btn.disabled = true; err.show('');
      try {
        const r = await api('POST', `/invite/${invite}/signup`, { slotId: s.id, name: name.value, contact: contact.value, note: note.value });
        mine.push({ signupId: r.signupId, slotId: r.slotId, editKey: r.editKey, name: name.value.trim() });
        store.set(key, mine);
        store.set('lastName', name.value.trim());
        openSlot = null;
        toast('You’re signed up');
        await refresh();
      } catch (x) { err.show(x.message); btn.disabled = false; await refresh(true); }
    } },
      h('div', { class: 'fields' },
        h('label', { class: 'field' }, 'Your name', name),
        h('label', { class: 'field' }, h('span', {}, 'Phone or email ', h('small', { text: '(optional, only the organizer sees it)' })), contact),
        h('label', { class: 'field full' }, h('span', {}, 'Note ', h('small', { text: '(optional)' })), note)),
      err, h('div', { class: 'row' }, btn));
    setTimeout(() => name.focus(), 0);
    return f;
  }

  async function cancel(m) {
    try {
      await api('DELETE', `/invite/${invite}/signup`, { signupId: m.signupId, editKey: m.editKey });
    } catch (_) { /* already gone — still forget it */ }
    mine = mine.filter(x => x !== m);
    store.set(key, mine);
    toast('Sign-up cancelled');
    await refresh();
  }

  async function refresh(keepOpen) {
    try { ev = await api('GET', '/invite/' + invite); } catch (_) {}
    if (!keepOpen) openSlot = null;
    render();
  }

  const taken = ev.slots.reduce((a, s) => a + s.taken, 0);
  const cap = ev.slots.reduce((a, s) => a + s.capacity, 0);
  app.replaceChildren(h('section', { class: 'sheet' },
    h('div', { class: 'event-head' },
      h('div', { class: 'row' }, h('span', { class: 'eyebrow', text: 'Sign-up sheet' }), ev.closed ? h('span', { class: 'badge closed', text: 'Sign-ups closed' }) : null),
      h('h1', { text: ev.title }),
      h('div', { class: 'meta' },
        ev.date ? h('span', {}, 'When ', h('b', { text: ev.date })) : null,
        ev.location ? h('span', {}, 'Where ', h('b', { text: ev.location })) : null,
        ev.host ? h('span', {}, 'Organizer ', h('b', { text: ev.host })) : null,
        h('span', {}, h('b', { text: `${taken} of ${cap}` }), ' spots filled')),
      ev.description ? h('p', { class: 'desc', text: ev.description }) : null),
    list,
    h('p', { class: 'warn', text: 'You can cancel your own sign-up from this device. Only the organizer can change the event.' })));
  render();
}

// ---------- organizer dashboard ----------

async function viewManage(id) {
  // Pull the code out of the #fragment, keep it for this tab, and clean the address bar.
  if (location.hash.length > 1) {
    session.set('code:' + id, decodeURIComponent(location.hash.slice(1)));
    history.replaceState({}, '', '/manage/' + id);
  }
  let code = session.get('code:' + id);
  if (!code) return askCode(id);

  app.replaceChildren(h('p', { class: 'muted', text: 'Opening dashboard…' }));
  let ev;
  try { ev = await api('GET', '/manage/' + id, null, code); }
  catch (x) { session.del('code:' + id); return askCode(id, x.message); }
  document.title = 'Manage: ' + ev.title + ' · Slotboard';

  const call = async (method, path, body) => api(method, '/manage/' + id + path, body, code);

  async function update(patch, msg) {
    try { ev = await call('PUT', '', patch); toast(msg || 'Saved'); draw(); }
    catch (x) { toast(x.message); }
  }

  function draw() {
    const taken = ev.slots.reduce((a, s) => a + s.signups.length, 0);
    const cap = ev.slots.reduce((a, s) => a + s.capacity, 0);
    const fullSlots = ev.slots.filter(s => s.signups.length >= s.capacity).length;

    // roster
    const roster = h('div', { class: 'slots' }, ev.slots.map(s => h('div', { class: 'slot' + (s.signups.length >= s.capacity ? ' full' : '') },
      h('div', { class: 'slot-main' },
        h('span', { class: 'slot-label', text: s.label }),
        s.when ? h('span', { class: 'slot-when', text: s.when }) : null),
      seats(s.signups.length, s.capacity),
      h('ul', { class: 'roster' }, s.signups.length ? s.signups.map(p => h('li', {},
        h('span', {}, h('span', { class: 'who', text: p.name }),
          p.contact ? h('span', { class: 'extra', text: ' · ' + p.contact }) : null,
          p.note ? h('span', { class: 'extra', text: ' · “' + p.note + '”' }) : null),
        h('button', { class: 'btn link', type: 'button', onclick: async () => {
          try { ev = await call('POST', '/remove', { signupId: p.id }); toast(`Removed ${p.name}`); draw(); } catch (x) { toast(x.message); }
        } }, 'Remove'))) : h('li', {}, h('span', { class: 'empty', text: 'Nobody yet' }))))));

    // edit form
    const err = errorBox();
    const f = {
      title: h('input', { type: 'text', id: 'e-title', maxlength: 120 }),
      date: h('input', { type: 'text', id: 'e-date', maxlength: 80 }),
      location: h('input', { type: 'text', id: 'e-loc', maxlength: 200 }),
      host: h('input', { type: 'text', id: 'e-host', maxlength: 80 }),
      description: h('textarea', { id: 'e-desc', maxlength: 2000 }),
    };
    for (const k in f) f[k].value = ev[k] || '';
    const slots = slotEditor(ev.slots);
    const editForm = h('form', { class: 'sheet', onsubmit: async e => {
      e.preventDefault(); err.show('');
      const next = slots.value();
      const dropped = ev.slots.filter(s => s.signups.length && !next.some(n => n.id === s.id));
      const body = { slots: next };
      for (const k in f) body[k] = f[k].value;
      try { ev = await call('PUT', '', body); toast(dropped.length ? 'Saved. Removed slots took their sign-ups with them.' : 'Saved'); draw(); }
      catch (x) { err.show(x.message); }
    } },
      h('div', { class: 'sheet-head' }, h('h2', { text: 'Edit event' })),
      h('div', { class: 'fields' },
        h('label', { class: 'field full' }, 'Event title', f.title),
        h('label', { class: 'field' }, 'Date', f.date),
        h('label', { class: 'field' }, 'Location (optional)', f.location),
        h('label', { class: 'field full' }, 'Organizer name', f.host),
        h('label', { class: 'field full' }, 'Details', f.description)),
      h('h3', { text: 'Slots' }),
      slots, err,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Save changes')));

    // invite + master code tools
    const confirmArea = h('div');
    const ask = (text, label, fn) => {
      confirmArea.replaceChildren(h('div', { class: 'confirm' }, h('p', { text }),
        h('div', { class: 'row' },
          h('button', { class: 'btn danger small', type: 'button', onclick: async () => { confirmArea.replaceChildren(); await fn(); } }, label),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => confirmArea.replaceChildren() }, 'Keep as is'))));
    };

    const newCodeIn = h('input', { type: 'text', id: 'n-code', placeholder: 'New code, or blank to generate', autocomplete: 'off' });
    const codeOut = h('div');

    const closed = h('input', { type: 'checkbox', id: 't-closed', checked: ev.closed, onchange: e => update({ closed: e.target.checked }, e.target.checked ? 'Sign-ups closed' : 'Sign-ups open') });
    const showN = h('input', { type: 'checkbox', id: 't-names', checked: ev.showNames, onchange: e => update({ showNames: e.target.checked }) });

    app.replaceChildren(
      h('section', { class: 'sheet' },
        h('div', { class: 'event-head' },
          h('div', { class: 'row' }, h('span', { class: 'badge key', text: 'Organizer' }), ev.closed ? h('span', { class: 'badge closed', text: 'Sign-ups closed' }) : null),
          h('h1', { text: ev.title }),
          h('div', { class: 'meta' },
            ev.date ? h('span', {}, 'When ', h('b', { text: ev.date })) : null,
            ev.location ? h('span', {}, 'Where ', h('b', { text: ev.location })) : null,
            h('span', {}, 'Event code ', h('b', { text: ev.id })))),
        h('div', { class: 'stat-row' },
          h('div', { class: 'stat' }, h('b', { text: `${taken}/${cap}` }), h('span', { text: 'spots filled' })),
          h('div', { class: 'stat' }, h('b', { text: `${fullSlots}/${ev.slots.length}` }), h('span', { text: 'slots full' }))),
        linkBox('Invite link — share this', inviteUrl(ev.invite), { open: true }),
        h('div', { class: 'row' },
          h('label', { class: 'check' }, closed, h('span', {}, 'Close sign-ups')),
          h('label', { class: 'check' }, showN, h('span', {}, 'Show names to invitees')))),

      h('section', { class: 'sheet' },
        h('div', { class: 'row', style: 'justify-content:space-between' },
          h('h2', { text: 'Who’s signed up' }),
          h('div', { class: 'row' },
            h('button', { class: 'btn small ghost', type: 'button', onclick: async () => {
              try { ev = await call('GET', ''); draw(); toast('Up to date'); } catch (x) { toast(x.message); }
            } }, 'Refresh'),
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => exportCsv(ev) }, 'Download CSV'))),
        roster),

      editForm,

      h('section', { class: 'sheet' },
        h('div', { class: 'sheet-head' }, h('h2', { text: 'Links and master code' })),
        h('div', { class: 'split' },
          h('div', { class: 'linkbox' },
            h('h3', { text: 'New invite link' }),
            h('p', { class: 'warn', text: 'Makes a fresh invite link. The old one stops working, but existing sign-ups stay.' }),
            h('div', { class: 'row' }, h('button', { class: 'btn small ghost', type: 'button', onclick: () =>
              ask('Replace the invite link? Anyone using the old link will see an error.', 'Replace link', async () => {
                try { ev = await call('POST', '/new-invite'); toast('New invite link ready'); draw(); } catch (x) { toast(x.message); }
              }) }, 'Replace invite link'))),
          h('div', { class: 'linkbox master' },
            h('h3', { text: 'Change master code' }),
            h('label', { class: 'field' }, 'New master code', newCodeIn),
            h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: async () => {
              try {
                const r = await call('POST', '/new-code', { masterCode: newCodeIn.value });
                code = r.masterCode; session.set('code:' + id, code);
                const c = h('span', { class: 'code', text: code });
                codeOut.replaceChildren(h('div', { class: 'linkbox' }, h('span', { class: 'badge key', text: 'New master code' }), c,
                  h('div', { class: 'url', text: masterUrl(id, code) }),
                  h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => copy(masterUrl(id, code)) }, 'Copy master link'))));
                newCodeIn.value = '';
                toast('Master code changed. Save the new one.');
              } catch (x) { toast(x.message); }
            } }, 'Change code')),
            codeOut)),
        confirmArea,
        h('div', { class: 'row' },
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => copy(masterUrl(id, code)) }, 'Copy master link'),
          h('button', { class: 'btn small ghost', type: 'button', style: 'color:var(--danger);border-color:var(--danger)', onclick: () =>
            ask('Delete this event and every sign-up? This can’t be undone.', 'Delete event', async () => {
              try { await call('DELETE', ''); session.del('code:' + id); toast('Event deleted'); go('/'); } catch (x) { toast(x.message); }
            }) }, 'Delete event'),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => { session.del('code:' + id); go('/'); } }, 'Lock dashboard'))));
  }

  draw();
  // keep the roster current while the dashboard is open
  const timer = setInterval(async () => {
    if (!location.pathname.startsWith('/manage/' + id)) return clearInterval(timer);
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    try {
      const next = await call('GET', '');
      if (JSON.stringify(next.slots.map(s => s.signups.length)) !== JSON.stringify(ev.slots.map(s => s.signups.length))) { ev = next; draw(); }
    } catch (_) {}
  }, 20000);
}

function askCode(id, msg) {
  const err = errorBox(); err.show(msg || '');
  const input = h('input', { type: 'password', id: 'a-code', autocomplete: 'off', required: true });
  app.replaceChildren(h('form', { class: 'sheet', style: 'max-width:460px', onsubmit: e => {
    e.preventDefault();
    session.set('code:' + id, input.value.trim());
    viewManage(id);
  } },
    h('div', { class: 'sheet-head' }, h('span', { class: 'eyebrow', text: 'Organizer dashboard' }), h('h2', { text: 'Enter the master code' }),
      h('p', { class: 'muted' }, 'Event code ', h('b', { text: id }))),
    h('label', { class: 'field' }, 'Master code', input),
    err,
    h('button', { class: 'btn', type: 'submit' }, 'Unlock')));
  input.focus();
}

function exportCsv(ev) {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['Slot', 'When', 'Name', 'Contact', 'Note', 'Signed up at'].map(q).join(',')];
  for (const s of ev.slots) for (const p of s.signups) lines.push([s.label, s.when, p.name, p.contact, p.note, p.at].map(q).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: ev.title.replace(/[^\w-]+/g, '_') + '_signups.csv' });
  document.body.append(a); a.click(); a.remove();
}

// ---------- router ----------

function go(path) { history.pushState({}, '', path); route(); }

function route() {
  const p = location.pathname.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (p[0] === 'e' && p[1]) return viewInvite(p[1]);
  if (p[0] === 'manage' && p[1]) return viewManage(p[1]);
  viewHome();
  if (location.hash === '#create' || location.hash === '#manage') document.querySelector(location.hash)?.scrollIntoView();
}

window.addEventListener('popstate', route);
document.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('download') || a.origin !== location.origin || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  history.pushState({}, '', a.pathname + a.hash);
  route();
});
route();
