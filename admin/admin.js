// The Cloche admin page: make the database entry for a plant and the sticker that points at it.
// See docs/cloche-admin-plan.md. Nothing here is trusted: the page is public, and the database
// refuses everyone who is not the admin (listed in `admins` and signed in with MFA), so this file
// only decides what to ask for. It never holds a secret.
import { labelSvg, labelUrl } from './sticker.js';

const IDLE_MS = 30 * 60 * 1000; // sign out after half an hour of nothing
const QUEUE_KEY = 'cloche-admin-queue';
const POLL_MS = 3000;
const POLL_FOR_MS = 150000; // the lookup runs for up to 150 s on Supabase
const MAX_COMMON = 28; // longest plant name that fits the dome at its printed size
const CODE_RE = /^[A-Z0-9]{3}-[A-Z0-9]{4}$/;

let sb;
let root;
let printRoot;
let idleTimer;
let adminEmail = ''; // the one admin's address, so sign-in only asks for a password

const st = {
  user: null,
  tab: 'make',
  loaded: false,
  shops: [],
  care: [],
  tags: [],
  stats: new Map(),
  queue: [],
  review: [], // admin_care_queue: unreviewed species, most-used first
  reviewing: null, // { care, form, careMsg } while one is open on the Care tab
  careSearch: '', // filter for the Care tab's list of every species
  make: freshMake(),
  filter: { shop: '', text: '', archived: false },
  banner: null,
};

function freshMake() {
  return {
    shopId: '',
    addingShop: false,
    newShop: { name: '', slug: '', prefix: '', area: '' },
    species: '',
    care: null, // the species_care row, or { manual: true } for one not saved yet
    form: null, // the editable copy of its care
    searched: false,
    looking: false,
    commonName: '',
    printName: '',
    result: null,
    busy: false,
    msg: null,
    careMsg: null,
    stickerMsg: null,
  };
}

// ------------------------------------------------------------------ small helpers

/** Builds an element. Children may be nodes, strings or arrays; props starting "on" are listeners. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const late = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') late[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  Object.assign(el, late); // after the options exist, for selects
  return el;
}

// An empty fragment when there is nothing to say, so it can be passed straight to append().
const notice = (kind, text) => (text ? h('p', { class: `notice ${kind || ''}`, role: kind === 'error' ? 'alert' : 'status' }, text) : document.createDocumentFragment());

function explain(err) {
  const msg = err?.message || String(err);
  if (err?.code === '42501' || /row-level security|permission denied|Not authorised/i.test(msg)) {
    return 'Not allowed. Your session may have expired: sign out and sign in again.';
  }
  if (err?.code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
    return 'That already exists. Names, slugs and prefixes must be different from the others.';
  }
  if (err?.code === '23514' || /check constraint/i.test(msg)) return 'One of the values is not allowed. Check the lengths and characters.';
  return msg;
}

/** Unwraps a Supabase answer or throws its error. */
async function ok(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const initials = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
const shopById = (id) => st.shops.find((s) => s.id === id);
const careFor = (species) => st.care.find((c) => c.species_scientific === species);

/** The name printed in a sticker's band: the print name if one is set, else the shop. */
const printedShop = (tag) => tag.display_shop_name || shopById(tag.shop_id)?.name || '';

function stickerItem(tag) {
  const care = careFor(tag.species_scientific);
  return {
    code: tag.code,
    common: tag.species_common || care?.species_common || tag.species_scientific,
    shop: printedShop(tag),
  };
}

function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ print queue

function loadQueue() {
  try {
    const q = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(q) ? q.filter((i) => CODE_RE.test(i?.code)) : [];
  } catch {
    return [];
  }
}
function saveQueue() {
  try {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(st.queue));
  } catch {
    /* the queue just won't survive a reload */
  }
}
function enqueue(item) {
  st.queue.push({ code: item.code, common: item.common, shop: item.shop });
  saveQueue();
  render();
}

function printItems(items) {
  const svgs = items.map((i) => labelSvg(i));
  const sheets = [];
  for (let i = 0; i < svgs.length; i += 6) sheets.push(h('div', { class: 'sheet' }));
  // The svg text is built by sticker.js with every name escaped, so it is safe to place as markup.
  sheets.forEach((sheet, n) => {
    sheet.innerHTML = svgs.slice(n * 6, n * 6 + 6).join('');
  });
  printRoot.replaceChildren(...sheets);
  const go = () => window.print();
  if (document.fonts?.ready) document.fonts.ready.then(go, go);
  else go();
}

// ------------------------------------------------------------------ dialogs

function modal(title, content, buttons) {
  const dlg = h('dialog', { 'aria-label': title });
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.addEventListener('cancel', () => setTimeout(() => dlg.remove(), 0));
  dlg.append(h('div', { class: 'card' }, h('h2', {}, title), content, h('div', { class: 'row' }, buttons(close))));
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

function showSticker(item) {
  modal(
    `Sticker ${item.code}`,
    h(
      'div',
      { class: 'sticker-row' },
      stickerBox(item),
      h(
        'div',
        { class: 'actions' },
        h('p', { class: 'small muted' }, `The QR holds ${labelUrl(item.code)}. Print the sheet at 100% scale, headers and footers off, on matt waterproof vinyl.`)
      )
    ),
    (close) => [
      btn('Download SVG', () => saveFile(`${item.code}.svg`, labelSvg({ ...item, standalone: true }), 'image/svg+xml')),
      btn('Add to print queue', () => { enqueue(item); close(); }, 'secondary'),
      btn('Print this one', () => printItems([item]), 'secondary'),
      btn('Close', close, 'secondary'),
    ]
  );
}

function stickerBox(item) {
  const box = h('div', { class: 'sticker', role: 'img', 'aria-label': `Sticker for ${item.common}, code ${item.code}` });
  box.innerHTML = labelSvg(item); // built by sticker.js with every name escaped
  return box;
}

/** A card's heading: an optional step badge, the title, and anything for the right-hand end. */
function cardHead(step, title, ...extra) {
  const done = step === '✓';
  return h('header', {},
    step ? h('span', { class: `step${done ? ' done' : ''}`, 'aria-hidden': 'true' }, step) : null,
    h('h2', {}, title),
    extra.length ? h('span', { class: 'head-extra' }, extra) : null);
}
const lede = (text) => h('p', { class: 'lede' }, text);

// ---- the row of sprouts at the foot of every page, as on cloche.one. The pattern is fixed (seeded)
// so it doesn't reshuffle every time the page redraws.
const SPROUT = '<path d="M60 102 V87.6" stroke="#A3B566" stroke-width="4.8" stroke-linecap="round" fill="none"/>' +
  '<path d="M60 90 C60 80.4 67.2 75.6 75.6 75.6 C75.6 84 69.6 90 60 90 Z M60 93.6 C60 85.2 52.8 81.6 45.6 81.6 C45.6 88.8 51.6 93.6 60 93.6 Z" fill="#A3B566"/>';

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function growSprouts(svg) {
  const rand = seeded(21);
  const w = svg.clientWidth || 600;
  const height = 64;
  let x = 30 + rand() * 20;
  let prev = 0;
  let out = '';
  svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
  while (x < w - 30) {
    let sc = 0.8 + rand() * 1.1;
    if (prev && Math.abs(sc - prev) < 0.3) sc = Math.min(1.9, Math.max(0.8, prev + (rand() < 0.5 ? -0.45 : 0.45)));
    prev = sc;
    const flip = rand() < 0.5 ? -1 : 1;
    out += `<g transform="translate(${x.toFixed(1)} ${height}) scale(${(sc * flip).toFixed(2)} ${sc.toFixed(2)}) translate(-60 -102)">${SPROUT}</g>`;
    x += 90 + rand() * 130;
  }
  svg.innerHTML = out; // fixed markup built here, no input in it
}

function pageFoot() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'shelf');
  svg.setAttribute('aria-hidden', 'true');
  const foot = h('footer', { class: 'foot' }, h('div', { class: 'shelf-wrap' }, svg), h('p', { class: 'small muted' }, 'Cloche admin · private'));
  requestAnimationFrame(() => {
    growSprouts(svg);
    let last = svg.clientWidth;
    new ResizeObserver(() => {
      if (Math.abs(svg.clientWidth - last) > 40) { last = svg.clientWidth; growSprouts(svg); }
    }).observe(svg);
  });
  return foot;
}

const btn = (text, onclick, kind = '', extra = {}) => h('button', { type: 'button', class: `btn ${kind}`.trim(), onclick, ...extra }, text);

// ------------------------------------------------------------------ sign-in

function showScreen(...nodes) {
  clearTimeout(idleTimer);
  root.replaceChildren(h('div', { class: 'centre' }, h('img', { class: 'mark', src: '/favicon.svg', alt: '' }), h('h1', {}, 'Cloche admin'), ...nodes), pageFoot());
}

function signInScreen(note) {
  // Normally just a password (the admin's address is known to the page). "Email me a code" is the
  // way in the first time, before a password is set, and if it is forgotten.
  let mode = adminEmail ? 'password' : 'email';
  let email = adminEmail;
  let sent = false;
  let busy = false;
  let message = note ? { kind: 'ok', text: note } : null;

  const draw = () => {
    const form = h('form', { class: 'card', onsubmit: submit });
    if (mode === 'password') {
      form.append(
        // For password managers, which look for a username next to the password.
        h('input', { type: 'email', name: 'username', autocomplete: 'username', value: adminEmail, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' }),
        h('label', { class: 'field' }, 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
        notice(message?.kind, message?.text),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'submit', disabled: busy }, busy ? 'Checking…' : 'Sign in'),
          btn('Email me a code instead', () => { mode = 'email'; sent = false; message = null; draw(); }, 'secondary'))
      );
    } else if (!sent) {
      form.append(
        h('label', { class: 'field' }, 'Email', h('input', { type: 'email', autocomplete: 'username', required: true, value: email, oninput: (e) => (email = e.target.value.trim()) })),
        notice(message?.kind, message?.text),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'submit', disabled: busy }, busy ? 'Sending…' : 'Email me a code'),
          adminEmail ? btn('Use my password', () => { mode = 'password'; message = null; draw(); }, 'secondary') : null)
      );
    } else {
      form.append(
        h('p', {}, `We sent a code to ${email}.`),
        h('label', { class: 'field' }, 'Code from the email', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', minlength: 6, maxlength: 10, required: true })),
        notice(message?.kind, message?.text),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'submit', disabled: busy }, busy ? 'Checking…' : 'Sign in'),
          btn('Back', () => { sent = false; message = null; draw(); }, 'secondary'))
      );
    }
    showScreen(form);
    form.querySelector('input:not(.sr-only)')?.focus();
  };

  async function submit(e) {
    e.preventDefault();
    busy = true;
    message = null;
    const code = e.target.elements.code?.value.trim();
    const password = e.target.elements.password?.value;
    draw();
    try {
      if (mode === 'password') {
        try {
          await ok(sb.auth.signInWithPassword({ email: adminEmail, password }));
        } catch {
          throw new Error('That didn’t work. If you haven’t set a password yet, use “Email me a code instead”.');
        }
        busy = false;
        return afterSignIn();
      }
      if (!sent) {
        // shouldCreateUser: false, so this page can never create an account.
        await ok(sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }));
        sent = true;
      } else {
        await ok(sb.auth.verifyOtp({ email, token: code, type: 'email' }));
        busy = false;
        return afterSignIn();
      }
    } catch (err) {
      message = { kind: 'error', text: mode === 'password' || !sent ? explain(err) : 'That code didn’t work. It may be wrong or out of date.' };
    }
    busy = false;
    draw();
  }

  draw();
}

// ------------------------------------------------------------------ password

function setPassword() {
  let pw = '';
  let again = '';
  const err = h('div', {});
  const body = h('div', { class: 'grid2' },
    h('input', { type: 'email', name: 'username', autocomplete: 'username', value: st.user.email, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' }),
    h('label', { class: 'field' }, 'New password', h('input', { type: 'password', autocomplete: 'new-password', minlength: 6, oninput: (e) => (pw = e.target.value) }), h('span', { class: 'hint' }, 'At least 6 characters.')),
    h('label', { class: 'field' }, 'Again', h('input', { type: 'password', autocomplete: 'new-password', oninput: (e) => (again = e.target.value) })),
    err);
  modal('Set your password', body, (close) => [
    btn('Save password', async () => {
      if (pw.length < 6) return err.replaceChildren(notice('error', 'Use at least 6 characters.'));
      if (pw !== again) return err.replaceChildren(notice('error', 'The two passwords don’t match.'));
      try {
        await ok(sb.auth.updateUser({ password: pw }));
        close();
        st.banner = { kind: 'ok', text: 'Password saved. Next time, sign in with it.' };
        render();
      } catch (e) { err.replaceChildren(notice('error', explain(e))); }
    }),
    btn('Cancel', close, 'secondary'),
  ]);
}

// ------------------------------------------------------------------ MFA

async function mfaEnrolScreen(factors) {
  try {
    // A half-finished enrolment would block a new one with the same name.
    for (const f of factors?.all || []) if (f.factor_type === 'totp' && f.status === 'unverified') await sb.auth.mfa.unenroll({ factorId: f.id });
    const enrol = await ok(sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Cloche admin' }));
    let message = null;
    const draw = () => {
      const form = h('form', { class: 'card', onsubmit: verify },
        h('h2', {}, 'Set up your authenticator'),
        h('p', {}, 'Scan this with an authenticator app (1Password, Google Authenticator, Authy, or the iOS Passwords app), then enter the 6-digit code it shows.'),
        h('img', { class: 'qr-enrol', src: enrol.totp.qr_code, alt: 'QR code to add Cloche admin to your authenticator app' }),
        h('p', { class: 'small muted' }, 'Or type this key in:'),
        h('p', { class: 'mono small secret' }, enrol.totp.secret),
        h('label', { class: 'field' }, 'Code from the app', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, required: true })),
        notice('error', message),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Turn on'), signOutButton())
      );
      showScreen(form);
    };
    async function verify(e) {
      e.preventDefault();
      const code = e.target.elements.code.value.trim();
      try {
        await ok(sb.auth.mfa.challengeAndVerify({ factorId: enrol.id, code }));
        return afterSignIn();
      } catch {
        message = 'That code didn’t match. Check the app and try again.';
        draw();
      }
    }
    draw();
  } catch (err) {
    showScreen(notice('error', explain(err)), signOutButton());
  }
}

function mfaChallengeScreen(factorId) {
  let message = null;
  const draw = () => {
    const form = h('form', { class: 'card', onsubmit: verify },
      h('p', {}, 'Enter the 6-digit code from your authenticator app.'),
      h('label', { class: 'field' }, 'Code', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, required: true })),
      notice('error', message),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Continue'), signOutButton())
    );
    showScreen(form);
    form.querySelector('input').focus();
  };
  async function verify(e) {
    e.preventDefault();
    const code = e.target.elements.code.value.trim();
    try {
      await ok(sb.auth.mfa.challengeAndVerify({ factorId, code }));
      return afterSignIn();
    } catch {
      message = 'That code didn’t match. Codes change every 30 seconds, so try the next one.';
      draw();
    }
  }
  draw();
}

const signOutButton = () => btn('Sign out', signOut, 'secondary');

async function signOut(note) {
  st.user = null; // first, so the sign-out event below doesn't draw the sign-in screen twice
  await sb.auth.signOut().catch(() => {});
  st.loaded = false;
  st.make = freshMake();
  signInScreen(typeof note === 'string' ? note : null);
}

async function afterSignIn() {
  const { data } = await sb.auth.getUser();
  st.user = data?.user || null;
  if (!st.user) return signInScreen();
  let status;
  try {
    status = await ok(sb.rpc('admin_status'));
  } catch (err) {
    return showScreen(notice('error', explain(err)), signOutButton());
  }
  if (status === 'no') {
    return showScreen(notice('error', `${st.user.email} isn’t an admin account.`), signOutButton());
  }
  if (status === 'needs_mfa') {
    const factors = await ok(sb.auth.mfa.listFactors()).catch(() => null);
    const verified = factors?.totp?.find((f) => f.status === 'verified');
    return verified ? mfaChallengeScreen(verified.id) : mfaEnrolScreen(factors);
  }
  watchIdle();
  await refreshAll();
  render();
}

let watching = false;
function watchIdle() {
  const reset = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => signOut('You were signed out after 30 minutes of nothing.'), IDLE_MS);
  };
  if (!watching) for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, reset, { passive: true });
  watching = true;
  reset();
}

// ------------------------------------------------------------------ data

async function refreshAll() {
  try {
    const [shops, care, tags, stats] = await Promise.all([
      ok(sb.from('shops').select('*').order('name')),
      ok(sb.from('species_care').select('*').order('species_scientific')),
      ok(sb.from('plant_tags').select('*').order('created_at', { ascending: false })),
      ok(sb.rpc('admin_shop_stats')),
    ]);
    st.shops = shops;
    st.care = care;
    st.tags = tags;
    st.stats = new Map((stats || []).map((s) => [s.shop_id, s]));
    // The review queue is newer than the rest (Phase 2). Until its migration is applied the tab
    // just says so, and the other tabs still work.
    st.review = await ok(sb.rpc('admin_care_queue')).catch(() => null);
    st.loaded = true;
    st.banner = null;
  } catch (err) {
    st.banner = { kind: 'error', text: `Couldn’t load the data. ${explain(err)}` };
  }
}

async function refreshAndRender() {
  await refreshAll();
  render();
}

// ------------------------------------------------------------------ shell

const TABS = [
  ['make', 'Make a label'],
  ['labels', 'Labels'],
  ['shops', 'Shops'],
  ['review', 'Care'],
];

function render() {
  if (!st.user) return;
  const view = st.tab === 'labels' ? labelsView() : st.tab === 'shops' ? shopsView() : st.tab === 'review' ? reviewView() : makeView();
  const top = h('div', { class: 'top' }, h('div', { class: 'wrap bar' },
    h('img', { src: '/favicon.svg', alt: '' }),
    h('h1', {}, 'Cloche admin'),
    h('span', { class: 'who' }, st.user.email),
    btn('Set password', setPassword, 'secondary small'),
    btn('Sign out', signOut, 'secondary small')
  ));
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' }, h('div', { class: 'wrap tabrow' },
    TABS.map(([id, name]) => h('button', { type: 'button', 'aria-current': st.tab === id ? 'page' : null, onclick: () => { st.tab = id; render(); } }, name))
  ));
  const scroll = window.scrollY;
  root.replaceChildren(top, tabs, h('main', { class: 'wrap' }, notice(st.banner?.kind, st.banner?.text), view), pageFoot(), queueBar() || document.createDocumentFragment());
  window.scrollTo(0, scroll);
}

function queueBar() {
  if (!st.queue.length) return null;
  const n = st.queue.length;
  return h('div', { class: 'queue', role: 'region', 'aria-label': 'Print queue' },
    h('strong', {}, `Print queue: ${n} sticker${n === 1 ? '' : 's'} (${Math.ceil(n / 6)} sheet${n > 6 ? 's' : ''})`),
    btn('Print sheets', () => printItems(st.queue)),
    btn('Download SVGs', () => st.queue.forEach((i, k) => setTimeout(() => saveFile(`${i.code}.svg`, labelSvg({ ...i, standalone: true }), 'image/svg+xml'), k * 300)), 'secondary'),
    btn('Clear', () => { st.queue = []; saveQueue(); render(); }, 'secondary')
  );
}

// ------------------------------------------------------------------ make a label

const careFormFrom = (row) => ({
  species_common: row?.species_common ?? '',
  watering_interval_days: row?.watering_interval_days ?? '',
  typical_environment: row?.typical_environment ?? 'indoor',
  light: row?.light ?? '',
  humidity: row?.humidity ?? '',
  animal_toxicity: row?.animal_toxicity ?? '',
  plant_type: row?.plant_type ?? '',
  placement: row?.placement ?? '',
  soil: row?.soil ?? '',
  feed_type: row?.feed_type ?? '',
  feed_amount: row?.feed_amount ?? '',
  feed_interval_days: row?.feed_interval_days ?? '',
  feed_months: (row?.feed_months ?? []).join(', '),
  repot_every_months: row?.repot_every_months ?? '',
  repot_notes: row?.repot_notes ?? '',
  light_level: row?.light_level ?? '',
  humidity_level: row?.humidity_level ?? '',
  spot_kind: row?.spot_kind ?? '',
  soil_kind: row?.soil_kind ?? '',
  feed_kind: row?.feed_kind ?? '',
  repot_kind: row?.repot_kind ?? '',
  ...Object.fromEntries(CARE_NOTE_FIELDS.map(([key]) => [`note_${key}`, row?.care_notes?.[key] ?? ''])),
  reviewed: row?.reviewed ?? false,
});

// The fuller note kept beside each short field (species_care.care_notes, migration
// 20261026000800): what the lookup found that the tile text had to leave out.
const CARE_NOTE_FIELDS = [
  ['light', 'Light'],
  ['humidity', 'Humidity'],
  ['placement', 'Spot'],
  ['soil', 'Soil'],
  ['feed', 'Feeding'],
  ['repot', 'Repotting'],
];
const NOTE_LIMIT = 300;

// The categories that pick each tile's icon in the app (species_care check constraints,
// migration 20261026000700). Same order and words as the app's tiles.
const CARE_CATEGORIES = {
  light_level: ['Light icon', [['full_sun', 'Full sun'], ['bright_indirect', 'Bright, indirect'], ['part_shade', 'Part shade'], ['shade', 'Shade, low light']]],
  humidity_level: ['Humidity icon', [['low', 'Low, dry air'], ['average', 'Average room'], ['high', 'High, humid']]],
  spot_kind: ['Spot icon', [['windowsill', 'Windowsill'], ['near_window', 'Near a window'], ['in_room', 'In the room'], ['garden_border', 'Garden border'], ['patio_pot', 'Patio pot']]],
  soil_kind: ['Soil icon', [['multipurpose', 'Multipurpose compost'], ['free_draining', 'Free-draining, gritty'], ['ericaceous', 'Ericaceous'], ['bark', 'Bark mix']]],
  feed_kind: ['Fertiliser icon', [['balanced_liquid', 'Balanced liquid'], ['high_potash', 'High-potash'], ['granules', 'Slow-release granules'], ['specialist', 'Half strength or specialist'], ['none', 'Not needed']]],
  repot_kind: ['Repotting icon', [['regular', 'Every so often'], ['rarely', 'Rarely'], ['in_ground', 'In the ground']]],
};

/** "3, 4, 5" → [3, 4, 5]; months must be 1 to 12. Empty means no feeding months. */
function parseMonths(text) {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const months = parts.map(Number);
  if (months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
    throw new Error('Feed in months: whole numbers from 1 (January) to 12, separated by commas.');
  }
  return [...new Set(months)].sort((a, b) => a - b);
}

/** An optional whole number in a range, or null when blank. */
function optionalInt(text, min, max, label) {
  if (String(text).trim() === '') return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: a whole number from ${min} to ${max}, or blank.`);
  return n;
}

// The groups the app's greenhouse filter uses. Same list as species_care's check constraint.
const PLANT_TYPES = [
  ['herb', 'Herbs'],
  ['succulent', 'Succulents & cacti'],
  ['flowering', 'Flowering'],
  ['foliage', 'Leafy'],
  ['tree', 'Trees & shrubs'],
  ['edible', 'Fruit & veg'],
];

function adoptCare(row) {
  const m = st.make;
  m.care = row;
  m.form = careFormFrom(row);
  m.species = row.species_scientific;
  m.commonName = m.commonName || row.species_common || '';
  m.searched = true;
  m.looking = false;
  m.result = null;
  m.careMsg = null;
  m.stickerMsg = null;
}

function makeView() {
  const m = st.make;
  const shop = shopById(m.shopId);
  return h('div', { class: 'card-stack' },
    shopCard(m, shop), plantCard(m), m.care ? careCard(m) : null, m.care ? stickerCard(m, shop) : null, m.result ? resultCard(m) : null
  );
}

function shopCard(m, shop) {
  const select = h('select', { id: 'shop', onchange: (e) => { m.addingShop = e.target.value === '+new'; if (!m.addingShop) m.shopId = e.target.value; m.result = null; render(); } },
    h('option', { value: '' }, 'Choose a shop…'),
    st.shops.map((s) => h('option', { value: s.id }, `${s.name}${s.prefix ? ` (${s.prefix})` : ' (no prefix yet)'}`)),
    h('option', { value: '+new' }, '+ Add a new shop…')
  );
  select.value = m.addingShop ? '+new' : m.shopId;
  return h('section', { class: 'card' },
    cardHead('1', 'Which shop is the sticker for?'),
    lede('The shop’s name is printed on the sticker, and the shop is credited for plants added from it.'),
    h('label', { class: 'field', for: 'shop' }, 'Shop', select),
    m.addingShop ? newShopForm(m) : null,
    shop && !shop.prefix ? h('p', { class: 'notice error' }, 'This shop has no three-character prefix yet, so it can’t have codes. Set one on the Shops tab.') : null
  );
}

function newShopForm(m) {
  const n = m.newShop;
  let msg = null;
  const form = h('form', { class: 'grid2', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const row = await ok(sb.from('shops').insert({ name: n.name.trim(), slug: n.slug || slugify(n.name), prefix: n.prefix.toUpperCase(), area: n.area.trim() || null }).select().single());
      m.newShop = { name: '', slug: '', prefix: '', area: '' };
      m.addingShop = false;
      await refreshAll();
      m.shopId = row.id;
      render();
    } catch (err) {
      msg = explain(err);
      form.querySelector('.notice')?.remove();
      form.append(notice('error', msg));
    }
  } },
    h('label', { class: 'field' }, 'Shop name', h('input', { required: true, maxlength: 60, value: n.name, oninput: (e) => { n.name = e.target.value; const slug = form.elements.slug; const pre = form.elements.prefix; if (!n.slugTouched) slug.value = n.slug = slugify(n.name); if (!n.prefixTouched) pre.value = n.prefix = initials(n.name); } })),
    h('label', { class: 'field' }, 'Web name (slug)', h('input', { name: 'slug', required: true, pattern: '[a-z0-9\\-]+', value: n.slug, oninput: (e) => { n.slug = e.target.value; n.slugTouched = true; } })),
    h('label', { class: 'field' }, 'Code prefix', h('input', { name: 'prefix', required: true, pattern: '[A-Za-z0-9]{3}', maxlength: 3, class: 'mono', value: n.prefix, oninput: (e) => { n.prefix = e.target.value.toUpperCase(); n.prefixTouched = true; }, }), h('span', { class: 'hint' }, 'Three letters or digits. Codes look like UPL-7K4Q.')),
    h('label', { class: 'field' }, 'Area (optional)', h('input', { maxlength: 80, value: n.area, placeholder: 'The Liberties, Dublin 8', oninput: (e) => (n.area = e.target.value) })),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Add shop'))
  );
  return form;
}

function plantCard(m) {
  const list = h('datalist', { id: 'species-list' }, st.care.map((c) => h('option', { value: c.species_scientific }, c.species_common || '')));
  const input = h('input', { id: 'species', list: 'species-list', value: m.species, autocomplete: 'off', spellcheck: 'false', placeholder: 'Nephrolepis exaltata \'Bostoniensis\'', oninput: (e) => { m.species = e.target.value; } });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); findSpecies(); } },
    h('label', { class: 'field', for: 'species' }, 'Scientific name', input, h('span', { class: 'hint' }, 'Exactly as the garden centre gave it, cultivar included. Care is stored under this name.')),
    list,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'submit' }, 'Find'))
  );
  const missing = m.searched && !m.care;
  return h('section', { class: 'card' },
    cardHead('2', 'Which plant?'),
    form,
    missing ? h('div', { class: 'notice' },
      h('p', {}, `Cloche has no care for ${m.species.trim()} yet.`),
      h('div', { class: 'row' },
        btn(m.looking ? 'Looking it up…' : 'Look up care', lookUp, '', { disabled: m.looking }),
        btn('Enter it by hand', enterByHand, 'secondary', { disabled: m.looking })),
      m.looking ? h('p', { class: 'small muted' }, 'This takes up to a couple of minutes. You can leave this page open.') : null
    ) : null,
    notice(m.msg?.kind, m.msg?.text)
  );
}

async function findSpecies() {
  const m = st.make;
  const name = m.species.trim();
  if (!name) return;
  m.msg = null;
  m.result = null;
  try {
    const known = st.care.find((c) => c.species_scientific.toLowerCase() === name.toLowerCase());
    const row = known || (await ok(sb.from('species_care').select('*').eq('species_scientific', name).maybeSingle()));
    if (row) adoptCare(row);
    else { m.care = null; m.form = null; m.searched = true; }
  } catch (err) {
    m.msg = { kind: 'error', text: explain(err) };
  }
  render();
}

function enterByHand() {
  const m = st.make;
  m.care = { manual: true, species_scientific: m.species.trim() };
  m.form = careFormFrom(null);
  m.msg = null;
  render();
}

async function lookUp() {
  const m = st.make;
  const name = m.species.trim();
  m.looking = true;
  m.msg = null;
  render();
  try {
    const { data, error } = await sb.functions.invoke('species-care', { body: { scientificName: name } });
    if (error) {
      let text = error.message;
      try { text = (await error.context.json()).error || text; } catch { /* keep the message */ }
      throw new Error(text);
    }
    if (data?.care) { adoptCare(data.care); await refreshAll(); return render(); }
    const stop = Date.now() + POLL_FOR_MS;
    while (Date.now() < stop && st.make === m && m.looking) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const row = await ok(sb.from('species_care').select('*').eq('species_scientific', name).maybeSingle());
      if (row) { adoptCare(row); await refreshAll(); return render(); }
    }
    throw new Error('The lookup is taking longer than expected. Wait a minute and press Find again, or enter the care by hand.');
  } catch (err) {
    m.looking = false;
    m.msg = { kind: 'error', text: explain(err) };
    render();
  }
}

// ------------------------------------------------------------------ care editor
//
// One card per care topic, in the app's colours (cloche-app/src/constants/care-palette.ts), so
// everything about light, say, is in one place: its icon, the tile text, the fuller note and a
// live preview of the tile as the app draws it (cloche-app/src/lib/care-tiles.ts).

// Characters each tile text should fit (the app's CARE_TEXT_LIMITS), and the database's looser
// limits, which the boxes enforce. Over the first is allowed but shown: the tile may wrap.
const TILE_BUDGET = { light: 60, humidity: 60, placement: 90, soil: 80, feed_type: 60, feed_amount: 50, repot_notes: 100 };
const DB_LIMIT = { light: 200, humidity: 200, placement: 200, soil: 160, feed_type: 120, feed_amount: 120, repot_notes: 200 };

// Each category's icon file in ./care-icons/ (copied from docs/brand/icons/care/).
const CATEGORY_ICON = {
  light_level: { full_sun: 'light-full-sun', bright_indirect: 'light-bright-indirect', part_shade: 'light-part-shade', shade: 'light-shade' },
  humidity_level: { low: 'humidity-low', average: 'humidity-average', high: 'humidity-high' },
  spot_kind: { windowsill: 'spot-windowsill', near_window: 'spot-near-window', in_room: 'spot-in-room', garden_border: 'spot-garden-border', patio_pot: 'spot-patio-pot' },
  soil_kind: { multipurpose: 'soil-multipurpose', free_draining: 'soil-free-draining', ericaceous: 'soil-ericaceous', bark: 'soil-bark' },
  feed_kind: { balanced_liquid: 'fertiliser-balanced-liquid', high_potash: 'fertiliser-high-potash', granules: 'fertiliser-granules', specialist: 'fertiliser-specialist', none: 'fertiliser-none' },
  repot_kind: { regular: 'repot-regular', rarely: 'repot-rarely', in_ground: 'repot-in-ground' },
};

/** A care icon, light and dark, like the app's (on its own disc). */
function careIcon(name, size = 36) {
  return h('picture', { class: 'care-icon' },
    h('source', { srcset: `care-icons/cloche-care-${name}-dark.svg`, media: '(prefers-color-scheme: dark)' }),
    h('img', { src: `care-icons/cloche-care-${name}.svg`, width: size, height: size, alt: '' }));
}

const categoryLabel = (name, value) => CARE_CATEGORIES[name][1].find(([v]) => v === value)?.[1];

/** A text box that grows with its text, with a "44 / 60" count that turns red past `budget`. */
function countedText(f, name, { budget, max, rows = 1, onChange }) {
  const count = h('span', { class: 'count' });
  const box = h('textarea', { rows, maxlength: max, value: f[name] });
  const update = () => {
    const n = f[name].trim().length;
    count.textContent = budget ? `${n} / ${budget}` : `${n}`;
    count.classList.toggle('over', !!budget && n > budget);
    count.title = budget && n > budget ? 'Longer than the tile was designed for: it may wrap. Shorten it if you can.' : '';
  };
  box.addEventListener('input', (e) => { f[name] = e.target.value; update(); onChange?.(); });
  update();
  return { box, count };
}

/** What the app's tile says for a topic, from the form (mirrors care-tiles.ts). */
function tileFor(topic, f) {
  const text = (v) => (v || '').trim();
  if (topic.key === 'feed') {
    if (f.feed_kind === 'none') return { icon: 'fertiliser-none', headline: 'Not needed', detail: '' };
    return { icon: CATEGORY_ICON.feed_kind[f.feed_kind] || 'fertiliser-balanced-liquid', headline: text(f.feed_type), detail: text(f.feed_amount) };
  }
  if (topic.key === 'repot') {
    const every = Number(f.repot_every_months);
    const headline = f.repot_kind === 'in_ground' ? 'Grown in the ground'
      : f.repot_kind === 'rarely' ? 'Rarely'
      : every ? (every === 12 ? 'Every year' : every % 12 === 0 ? `Every ${every / 12} years` : `Every ${every} months`) : '';
    return { icon: CATEGORY_ICON.repot_kind[f.repot_kind] || 'repot-regular', headline, detail: text(f.repot_notes) };
  }
  const label = categoryLabel(topic.category, f[topic.category]);
  return {
    icon: CATEGORY_ICON[topic.category][f[topic.category]] || topic.fallbackIcon,
    // No category yet: the app shows the text as the detail line, under no headline.
    headline: label || '',
    detail: text(f[topic.text]),
  };
}

/** The app's tile, drawn from the form: icon, small label in the family's ink, headline, detail. */
function tilePreview(topic, f) {
  const holder = h('div', { class: `tile-preview fam-${topic.family}` });
  const draw = () => {
    const tile = tileFor(topic, f);
    // replaceChildren would print a null as "null", so leave the missing parts out.
    holder.replaceChildren(...[
      careIcon(tile.icon, 32),
      h('div', { class: 'tile-label' }, topic.title),
      tile.headline ? h('div', { class: 'tile-headline' }, tile.headline) : null,
      tile.detail ? h('div', { class: 'tile-detail' }, tile.detail) : null,
      !tile.headline && !tile.detail ? h('div', { class: 'tile-detail' }, 'No tile: nothing to show yet.') : null,
    ].filter(Boolean));
  };
  draw();
  return { holder, draw };
}

const CARE_TOPICS = [
  { key: 'light', title: 'Light', family: 'sun', category: 'light_level', text: 'light', note: 'light', fallbackIcon: 'light-bright-indirect',
    hint: 'A short phrase; the icon gives the headline (e.g. “Bright, indirect”).' },
  { key: 'spot', title: 'Spot', family: 'sun', category: 'spot_kind', text: 'placement', note: 'placement', fallbackIcon: 'spot-windowsill',
    hint: 'Where in the home or garden, e.g. “Bright spot near a window, away from radiators”.' },
  { key: 'humidity', title: 'Humidity', family: 'water', category: 'humidity_level', text: 'humidity', note: 'humidity', fallbackIcon: 'humidity-average' },
  { key: 'soil', title: 'Soil', family: 'earth', category: 'soil_kind', text: 'soil', note: 'soil', fallbackIcon: 'soil-multipurpose' },
  { key: 'feed', title: 'Fertiliser and feeding', family: 'feed', category: 'feed_kind', text: 'feed_type', note: 'feed',
    hint: 'The kind of feed, never a brand. Leave the feed fields blank, and pick “Not needed”, for a plant that needs none.' },
  { key: 'repot', title: 'Repotting', family: 'earth', category: 'repot_kind', text: 'repot_notes', note: 'repot',
    hint: 'When and how, as a short phrase.' },
];

/** One care topic's card: icon, tile text, the topic's extra fields, fuller note, live tile. */
function topicCard(topic, f) {
  const preview = tilePreview(topic, f);
  const header = h('header', {}, careIcon(tileFor(topic, f).icon, 40), h('h3', {}, topic.title));
  const redraw = () => { preview.draw(); header.firstChild.replaceWith(careIcon(tileFor(topic, f).icon, 40)); };

  const options = CARE_CATEGORIES[topic.category][1];
  // For light, spot, humidity and soil the category is also the tile's headline.
  const catLabel = topic.key === 'feed' || topic.key === 'repot' ? 'Icon' : 'Icon and headline';
  const select = h('select', { value: f[topic.category], onchange: (e) => { f[topic.category] = e.target.value; redraw(); } },
    h('option', { value: '' }, 'Not set'), options.map(([v, label]) => h('option', { value: v }, label)));
  const text = countedText(f, topic.text, { budget: TILE_BUDGET[topic.text], max: DB_LIMIT[topic.text], onChange: redraw });
  const note = countedText(f, `note_${topic.note}`, { budget: NOTE_LIMIT, max: NOTE_LIMIT, rows: 3 });
  const numberField = (label, name, attrs, hint) => h('label', { class: 'field' }, label,
    h('input', { value: f[name], ...attrs, oninput: (e) => { f[name] = e.target.value; redraw(); } }), hint ? h('span', { class: 'hint' }, hint) : null);

  const extras = topic.key === 'feed'
    ? [
        (() => { const amount = countedText(f, 'feed_amount', { budget: TILE_BUDGET.feed_amount, max: DB_LIMIT.feed_amount, onChange: redraw });
          return h('label', { class: 'field' }, h('span', { class: 'field-top' }, 'How much', amount.count), amount.box, h('span', { class: 'hint' }, 'e.g. “Half strength”. The tile’s second line.')); })(),
        h('div', { class: 'pair' },
          numberField('Feed every (days)', 'feed_interval_days', { type: 'number', min: 1, max: 90, step: 1, inputmode: 'numeric' }),
          numberField('Feed in months', 'feed_months', { maxlength: 40 }, '1 = January, e.g. “3, 4, 5, 6, 7, 8, 9”.')),
      ]
    : topic.key === 'repot'
      ? [numberField('Repot every (months)', 'repot_every_months', { type: 'number', min: 1, max: 120, step: 1, inputmode: 'numeric' }, 'Blank for plants grown in the ground.')]
      : [];

  return h('section', { class: `topic fam-${topic.family}` },
    header,
    h('div', { class: 'topic-body' },
      h('div', { class: 'topic-fields' },
        h('label', { class: 'field' }, catLabel, select),
        h('label', { class: 'field' }, h('span', { class: 'field-top' }, topic.key === 'feed' ? 'Feed' : 'Tile text', text.count), text.box,
          topic.hint ? h('span', { class: 'hint' }, topic.hint) : null),
        extras,
        h('label', { class: 'field' }, h('span', { class: 'field-top' }, 'Fuller note', note.count), note.box,
          h('span', { class: 'hint' }, 'What the lookup found; the tile text summarises it.'))),
      h('div', { class: 'topic-preview' }, h('span', { class: 'hint' }, 'In the app'), preview.holder)));
}

/** The care editor. `m` holds { care, form, careMsg }: the Make tab's state, or the Care tab's. */
function careCard(m, step = '3') {
  const f = m.form;
  const row = m.care;
  const isNew = !!row.manual;
  const sources = Array.isArray(row.sources) ? row.sources : [];
  const status = isNew ? h('span', { class: 'pill warn' }, 'Not saved yet')
    : row.reviewed ? h('span', { class: 'pill ok' }, 'Reviewed') : h('span', { class: 'pill warn' }, 'Not reviewed');
  const field = (label, name, props = {}, hint) => h('label', { class: 'field' }, label,
    h('input', { value: f[name], oninput: (e) => (f[name] = e.target.value), ...props }), hint ? h('span', { class: 'hint' }, hint) : null);

  // Pets: coral, and only shown in the app when the plant is toxic.
  const petsPreview = h('div', { class: 'tile-preview fam-caution' });
  const drawPets = () => {
    const note = f.animal_toxicity.trim();
    const lower = note.toLowerCase();
    const icon = lower.includes('cat') && !lower.includes('dog') ? 'pets-cats' : lower.includes('dog') && !lower.includes('cat') ? 'pets-dogs' : 'pets-cats-and-dogs';
    petsPreview.replaceChildren(...(note
      ? [careIcon(icon, 32), h('div', { class: 'tile-label' }, 'Pets'), h('div', { class: 'tile-headline' }, note)]
      : [h('div', { class: 'tile-detail' }, 'No tile: not toxic, or not known.')]));
  };
  drawPets();

  return h('section', { class: 'card care-editor' },
    cardHead(step, `Care for ${row.species_scientific}`, status),
    lede('Cloche decides how often a plant is watered. Check each card, fix anything that’s off, then tick that it’s reviewed.'),
    row.review_note ? notice('warn', `Flagged by the lookup: ${row.review_note}. Saving as reviewed clears it.`) : null,
    !isNew ? h('p', { class: 'small muted' }, sources.length ? '' : 'No sources recorded.',
      sources.slice(0, 4).map((s, i) => [i ? ' · ' : 'Sources: ', /^https?:\/\//.test(s.url) ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || s.url) : (s.title || '')])) : null,

    h('section', { class: 'topic fam-basics' },
      h('header', {}, h('h3', {}, 'Basics')),
      h('div', { class: 'grid4' },
        field('Common name', 'species_common', { maxlength: 60 }),
        field('Water every (days)', 'watering_interval_days', { type: 'number', min: 1, max: 365, step: 1, inputmode: 'numeric' }, 'The default the app suggests.'),
        h('label', { class: 'field' }, 'Lives', h('select', { onchange: (e) => (f.typical_environment = e.target.value), value: f.typical_environment },
          h('option', { value: 'indoor' }, 'Indoors'), h('option', { value: 'outdoor' }, 'Outdoors')), h('span', { class: 'hint' }, 'Usually, in Ireland and the UK.')),
        h('label', { class: 'field' }, 'Plant type', h('select', { onchange: (e) => (f.plant_type = e.target.value), value: f.plant_type },
          h('option', { value: '' }, 'Not set'), PLANT_TYPES.map(([v, name]) => h('option', { value: v }, name))),
          h('span', { class: 'hint' }, 'The greenhouse filter.')))),

    h('section', { class: 'topic fam-caution' },
      h('header', {}, careIcon('pets-cats-and-dogs', 40), h('h3', {}, 'Pets')),
      h('div', { class: 'topic-body' },
        h('div', { class: 'topic-fields' },
          h('label', { class: 'field' }, 'Toxic to animals',
            h('input', { value: f.animal_toxicity, maxlength: 200, oninput: (e) => { f.animal_toxicity = e.target.value; drawPets(); } }),
            h('span', { class: 'hint' }, 'Only “Toxic to cats and dogs”, “Toxic to cats” or “Toxic to dogs”. Blank if it isn’t toxic: nothing shows.')),
          row.toxic_to_pets !== undefined ? h('p', { class: 'small muted' }, `Lookup flags (not shown in the app): pets ${triState(row.toxic_to_pets)}, children ${triState(row.toxic_to_children)}.`) : null),
        h('div', { class: 'topic-preview' }, h('span', { class: 'hint' }, 'In the app'), petsPreview))),

    CARE_TOPICS.map((topic) => topicCard(topic, f)),

    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.reviewed, onchange: (e) => (f.reviewed = e.target.checked) }),
      h('span', {}, 'I have checked this care. Labels are only made for reviewed care, so a scan always shows something right.')),
    h('div', { class: 'row' }, btn(isNew ? 'Save care' : 'Save changes', () => saveCareClicked(m))),
    notice(m.careMsg?.kind, m.careMsg?.text)
  );
}

const triState = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');

function careValues(f) {
  const days = Number(f.watering_interval_days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Water every: enter a whole number of days from 1 to 365.');
  return {
    species_common: f.species_common.trim() || null,
    watering_interval_days: days,
    typical_environment: f.typical_environment,
    light: f.light.trim() || null,
    humidity: f.humidity.trim() || null,
    animal_toxicity: f.animal_toxicity.trim() || null,
    plant_type: f.plant_type || null,
    placement: f.placement.trim() || null,
    soil: f.soil.trim() || null,
    feed_type: f.feed_type.trim() || null,
    feed_amount: f.feed_amount.trim() || null,
    feed_interval_days: optionalInt(f.feed_interval_days, 1, 90, 'Feed every'),
    feed_months: parseMonths(f.feed_months),
    repot_every_months: optionalInt(f.repot_every_months, 1, 120, 'Repot every'),
    repot_notes: f.repot_notes.trim() || null,
    ...Object.fromEntries(Object.keys(CARE_CATEGORIES).map((name) => [name, f[name] || null])),
    care_notes: Object.fromEntries(
      CARE_NOTE_FIELDS.map(([key]) => [key, f[`note_${key}`].trim()]).filter(([, note]) => note)
    ),
    // Checked by a person: whatever the lookup flagged has been looked at.
    ...(f.reviewed ? { review_note: null } : {}),
    reviewed: !!f.reviewed,
  };
}

async function saveCare(m = st.make) {
  const values = careValues(m.form);
  const row = m.care.manual
    ? await ok(sb.from('species_care').insert({ species_scientific: m.care.species_scientific, ...values, model: 'manual' }).select().single())
    : await ok(sb.from('species_care').update(values).eq('species_scientific', m.care.species_scientific).select().single());
  await refreshAll();
  if (m === st.make) {
    adoptCare(row);
    m.commonName = m.commonName || row.species_common || '';
  } else {
    m.care = row;
    m.form = careFormFrom(row);
  }
}

async function saveCareClicked(m = st.make) {
  m.careMsg = null;
  try {
    await saveCare(m);
    m.careMsg = { kind: 'ok', text: 'Care saved.' };
  } catch (err) {
    m.careMsg = { kind: 'error', text: explain(err) };
  }
  render();
}

function careDirty(m) {
  if (!m.care || m.care.manual) return true;
  const saved = careFormFrom(m.care);
  return Object.keys(saved).some((k) => String(saved[k]) !== String(m.form[k]));
}

/** Why a label can't be made yet, or null if it can. */
function blocker(m, shop) {
  if (!shop) return 'Choose a shop above.';
  if (!shop.prefix) return 'The shop needs a three-character prefix.';
  if (!m.form.reviewed) return 'Tick that you have checked the care.';
  if (!m.commonName.trim()) return 'Give the plant a name to print.';
  if (m.commonName.trim().length > MAX_COMMON) return `The printed name is too long for the dome (${MAX_COMMON} characters at most).`;
  return null;
}

function stickerCard(m, shop) {
  const found = shop && st.tags.find((t) => t.shop_id === shop.id && t.species_scientific === m.care.species_scientific && !t.archived_at);
  const existing = found && m.result?.tag.code !== found.code ? found : null; // not the one just made
  return h('section', { class: 'card' },
    cardHead('4', 'The sticker'),
    lede('What is printed on it. The code and QR are made for you when you create the label.'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, 'Plant name printed on it', h('input', { value: m.commonName, maxlength: 60, oninput: (e) => (m.commonName = e.target.value) }), h('span', { class: 'hint' }, 'The common name, small, with no Latin name.')),
      h('label', { class: 'field' }, 'Shop name printed on it', h('input', { value: m.printName, maxlength: 40, placeholder: shop?.name || '', oninput: (e) => (m.printName = e.target.value) }), h('span', { class: 'hint' }, 'Leave empty to print the shop’s own name. Credit still goes to the shop above.'))),
    existing ? h('p', { class: 'notice' }, `This shop already has a label for this plant: ${existing.code}. Pressing the button shows that one instead of making a second code.`) : null,
    h('div', { class: 'row' }, btn(m.busy ? 'Working…' : existing ? 'Show the existing label' : 'Create label', createLabel, '', { disabled: m.busy })),
    notice(m.stickerMsg?.kind, m.stickerMsg?.text)
  );
}

async function createLabel() {
  const m = st.make;
  const shop = shopById(m.shopId);
  const reason = blocker(m, shop);
  if (reason) {
    m.stickerMsg = { kind: 'error', text: reason };
    return render();
  }
  m.busy = true;
  m.stickerMsg = null;
  render();
  try {
    if (careDirty(m)) await saveCare();
    const created = await ok(sb.rpc('admin_create_tag', {
      p_shop_id: shop.id,
      p_species: m.care.species_scientific,
      p_common: m.commonName.trim(),
      p_display_shop_name: m.printName.trim() || null,
    }));
    const tag = Array.isArray(created) ? created[0] : created;
    // Read it back the way the app does on a scan. No sticker is shown until this agrees.
    const rows = await ok(sb.rpc('claim_tag', { p_code: tag.code }));
    const seen = rows?.[0];
    const problems = [];
    if (!seen) problems.push('the app does not recognise the code');
    else {
      if (seen.species_scientific !== m.care.species_scientific) problems.push('the species differs');
      if (seen.shop_id !== shop.id) problems.push('the shop differs');
      if (seen.watering_interval_days !== Number(m.form.watering_interval_days)) problems.push('the watering interval differs');
      if (seen.typical_environment !== m.form.typical_environment) problems.push('the indoor/outdoor setting differs');
    }
    await refreshAll();
    m.result = { tag, seen, problems, item: stickerItem(tag) };
  } catch (err) {
    m.stickerMsg = { kind: 'error', text: explain(err) };
  }
  m.busy = false;
  render();
}

function resultCard(m) {
  const { tag, seen, problems, item } = m.result;
  if (problems.length) {
    return h('section', { class: 'card' }, h('h2', {}, `Label ${tag.code}`),
      h('p', { class: 'notice error' }, `Don’t print this yet: ${problems.join(', ')}. Press the button again; if it persists, check the care and the shop.`));
  }
  const queued = st.queue.some((q) => q.code === item.code);
  return h('section', { class: 'card' },
    cardHead('✓', `Label ${tag.code} is in the database`),
    h('p', { class: 'notice ok' }, 'Read back the way the app does on a scan. This is what someone will see:'),
    h('div', { class: 'sticker-row' },
      stickerBox(item),
      h('div', { class: 'actions' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'Plant'), h('dd', {}, seen.species_common || '—'),
          h('dt', {}, 'Latin name'), h('dd', {}, seen.species_scientific),
          h('dt', {}, 'Water every'), h('dd', {}, `${seen.watering_interval_days} days`),
          h('dt', {}, 'Lives'), h('dd', {}, seen.typical_environment === 'outdoor' ? 'Outdoors' : 'Indoors'),
          h('dt', {}, 'Bought at'), h('dd', {}, seen.shop_name)),
        btn('Download SVG', () => saveFile(`${item.code}.svg`, labelSvg({ ...item, standalone: true }), 'image/svg+xml')),
        btn(queued ? 'In the print queue ✓' : 'Add to print queue', () => enqueue(item), 'secondary', { disabled: queued }),
        btn('Print this one', () => printItems([item]), 'secondary'),
        btn('Make another', () => { const shopId = m.shopId; st.make = freshMake(); st.make.shopId = shopId; render(); }, 'secondary'))))
  ;
}

// ------------------------------------------------------------------ labels

function labelsView() {
  const f = st.filter;
  const q = f.text.trim().toLowerCase();
  const tags = st.tags.filter((t) => {
    if (!f.archived && t.archived_at) return false;
    if (f.shop && t.shop_id !== f.shop) return false;
    if (!q) return true;
    const care = careFor(t.species_scientific);
    return [t.code, t.species_scientific, t.species_common, care?.species_common, shopById(t.shop_id)?.name].some((v) => v?.toLowerCase().includes(q));
  });
  const shopSelect = h('select', { 'aria-label': 'Filter by shop', onchange: (e) => { f.shop = e.target.value; render(); } },
    h('option', { value: '' }, 'All shops'), st.shops.map((s) => h('option', { value: s.id }, s.name)));
  shopSelect.value = f.shop;
  return h('div', { class: 'card-stack' },
    h('section', { class: 'card' }, cardHead(null, 'Labels'), lede('Every label made so far. Reprint a sticker, rename it, or change which shop it belongs to.'),
      h('div', { class: 'row filters' },
        h('input', { type: 'search', 'aria-label': 'Search labels', placeholder: 'Search code, plant or shop', value: f.text, oninput: (e) => { f.text = e.target.value; refreshTable(); } }),
        shopSelect,
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.archived, onchange: (e) => { f.archived = e.target.checked; render(); } }), 'Show archived'))),
    h('div', { class: 'tablewrap', id: 'label-table' }, labelTable(tags)),
    tags.length ? null : h('p', { class: 'muted' }, st.tags.length ? 'No labels match.' : 'No labels yet. Make one on the first tab.')
  );
}

function refreshTable() {
  // Typing in the search box must not rebuild the box itself, or it loses focus.
  const f = st.filter;
  const q = f.text.trim().toLowerCase();
  const tags = st.tags.filter((t) => (f.archived || !t.archived_at) && (!f.shop || t.shop_id === f.shop) &&
    (!q || [t.code, t.species_scientific, t.species_common, careFor(t.species_scientific)?.species_common, shopById(t.shop_id)?.name].some((v) => v?.toLowerCase().includes(q))));
  document.getElementById('label-table')?.replaceChildren(labelTable(tags));
}

function labelTable(tags) {
  return h('table', {},
    h('thead', {}, h('tr', {}, ['Code', 'Plant', 'Shop', 'Care', '', ].map((t) => h('th', {}, t)))),
    h('tbody', {}, tags.map((t) => {
      const care = careFor(t.species_scientific);
      return h('tr', { class: t.archived_at ? 'archived' : '' },
        h('td', { class: 'mono' }, t.code, t.archived_at ? h('div', {}, h('span', { class: 'pill' }, 'Archived')) : null),
        h('td', {}, t.species_common || care?.species_common || '—', h('div', { class: 'small muted' }, t.species_scientific)),
        h('td', {}, shopById(t.shop_id)?.name || '—', t.display_shop_name ? h('div', { class: 'small muted' }, `Printed: ${t.display_shop_name}`) : null),
        h('td', {}, care ? `${care.watering_interval_days ?? '?'} days · ${care.typical_environment || '?'}` : '—', care && !care.reviewed ? h('div', {}, h('span', { class: 'pill warn' }, 'Not reviewed')) : null),
        h('td', { class: 'actions' },
          btn('Sticker', () => showSticker(stickerItem(t)), 'secondary small'),
          btn('Edit', () => editLabel(t), 'secondary small'),
          btn('Change shop', () => changeShop(t), 'secondary small'),
          btn(t.archived_at ? 'Restore' : 'Archive', () => archiveLabel(t), 'secondary small')));
    })));
}

function editLabel(tag) {
  let common = tag.species_common || careFor(tag.species_scientific)?.species_common || '';
  let printName = tag.display_shop_name || '';
  const err = h('div', {});
  const body = h('div', { class: 'grid2' },
    h('label', { class: 'field' }, 'Plant name printed', h('input', { value: common, maxlength: 60, oninput: (e) => (common = e.target.value) })),
    h('label', { class: 'field' }, 'Shop name printed', h('input', { value: printName, maxlength: 40, placeholder: shopById(tag.shop_id)?.name || '', oninput: (e) => (printName = e.target.value) })),
    h('p', { class: 'small muted' }, 'The code and the plant can’t change: they are printed on pots. For a different plant, make a new label.'),
    err);
  modal(`Edit ${tag.code}`, body, (close) => [
    btn('Save', async () => {
      if (!common.trim() || common.trim().length > MAX_COMMON) return err.replaceChildren(notice('error', `Enter a plant name of up to ${MAX_COMMON} characters.`));
      try {
        await ok(sb.from('plant_tags').update({ species_common: common.trim(), display_shop_name: printName.trim() || null }).eq('code', tag.code).select().single());
        close();
        await refreshAndRender();
      } catch (e) { err.replaceChildren(notice('error', explain(e))); }
    }),
    btn('Cancel', close, 'secondary'),
  ]);
}

async function archiveLabel(tag) {
  try {
    await ok(sb.from('plant_tags').update({ archived_at: tag.archived_at ? null : new Date().toISOString() }).eq('code', tag.code).select().single());
    await refreshAndRender();
  } catch (e) {
    st.banner = { kind: 'error', text: explain(e) };
    render();
  }
}

function changeShop(tag) {
  const old = shopById(tag.shop_id);
  const used = st.stats.get(tag.shop_id)?.plants_added ?? 0;
  let target = '';
  let mode = 'move';
  const err = h('div', {});
  const select = h('select', { 'aria-label': 'New shop', onchange: (e) => (target = e.target.value) },
    h('option', { value: '' }, 'Choose a shop…'),
    st.shops.filter((s) => s.id !== tag.shop_id).map((s) => h('option', { value: s.id }, s.name)));
  const body = h('div', { class: 'grid2' },
    h('p', {}, `${tag.code} is at ${old?.name || 'a shop'}. ${used} plant${used === 1 ? ' has' : 's have'} been added from that shop’s labels so far; they keep their original shop. A custom print name is cleared when the label moves.`),
    h('label', { class: 'field' }, 'Move to', select),
    h('fieldset', { class: 'field' },
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', checked: true, onchange: () => (mode = 'move') }),
        h('span', {}, 'Keep this code and move the label. Use it before the sticker is printed, or to reprint. The QR doesn’t change.')),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'mode', onchange: () => (mode = 'new') }),
        h('span', {}, 'Make a new code in the new shop and archive this one. Use it when stickers with the old shop are already on pots: the old code keeps scanning.'))),
    err);
  modal(`Change shop for ${tag.code}`, body, (close) => [
    btn('Change shop', async () => {
      if (!target) return err.replaceChildren(notice('error', 'Choose the new shop.'));
      try {
        if (mode === 'move') {
          await ok(sb.from('plant_tags').update({ shop_id: target, display_shop_name: null }).eq('code', tag.code).select().single());
          close();
          await refreshAndRender();
          const moved = st.tags.find((t) => t.code === tag.code);
          if (moved) showSticker(stickerItem(moved));
        } else {
          const created = await ok(sb.rpc('admin_replace_tag', { p_code: tag.code, p_new_shop_id: target }));
          const fresh = Array.isArray(created) ? created[0] : created;
          close();
          await refreshAndRender();
          const row = st.tags.find((t) => t.code === fresh.code);
          if (row) showSticker(stickerItem(row));
        }
      } catch (e) { err.replaceChildren(notice('error', explain(e))); }
    }),
    btn('Cancel', close, 'secondary'),
  ]);
}

// ------------------------------------------------------------------ care to review

function reviewView() {
  const r = st.reviewing;
  if (r) {
    return h('div', { class: 'card-stack' },
      h('div', { class: 'row' }, btn('← Back to the list', () => { st.reviewing = null; render(); }, 'secondary small')),
      careCard(r, null));
  }
  const open = (care) => {
    st.reviewing = { care, form: careFormFrom(care), careMsg: null };
    render();
    window.scrollTo(0, 0);
  };
  const typeOf = (care) => PLANT_TYPES.find(([v]) => v === care?.plant_type)?.[1];

  // 1. Care nobody has checked yet, most-used first.
  const queue = h('section', { class: 'card' },
    cardHead(null, 'Care to review'),
    lede('Care the lookup wrote that nobody has checked yet, most-used first. Open one, fix anything that’s off, tick that it’s reviewed and save.'),
    st.review === null
      ? notice('error', 'The review list needs the Phase 2 migration (admin_care_queue). Run supabase db push, then reload.')
      : !st.review.length
        ? notice('ok', 'All care is reviewed.')
        : h('div', { class: 'tablewrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Species', 'Type', 'Plants', 'People', ''].map((t) => h('th', {}, t)))),
            h('tbody', {}, st.review.map((q) => {
              const care = careFor(q.species_scientific);
              return h('tr', {},
                h('td', {}, h('em', {}, q.species_scientific), care?.species_common ? h('div', { class: 'small muted' }, care.species_common) : null,
                  care?.review_note ? h('div', {}, h('span', { class: 'pill warn' }, care.review_note)) : null),
                h('td', {}, typeOf(care) || h('span', { class: 'pill warn' }, 'not set')),
                h('td', {}, q.plants), h('td', {}, q.people),
                h('td', { class: 'actions' }, care ? btn('Review', () => open(care), 'small') : null));
            })))));

  // 2. Every species, to edit any of them, reviewed or not.
  const term = st.careSearch.trim().toLowerCase();
  const shown = st.care.filter((c) => !term || `${c.species_scientific} ${c.species_common || ''}`.toLowerCase().includes(term));
  const search = h('input', { type: 'search', placeholder: 'Search by name', value: st.careSearch, 'aria-label': 'Search species',
    oninput: (e) => { st.careSearch = e.target.value; render(); document.querySelector('input[type=search]')?.focus(); } });
  const all = h('section', { class: 'card' },
    cardHead(null, `All species (${st.care.length})`),
    lede('Every species Cloche has care for. Open one to change its care, notes or icons.'),
    search,
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Species', 'Type', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, shown.map((care) => h('tr', {},
        h('td', {}, h('em', {}, care.species_scientific), care.species_common ? h('div', { class: 'small muted' }, care.species_common) : null),
        h('td', {}, typeOf(care) || '—'),
        h('td', {}, care.reviewed ? h('span', { class: 'pill ok' }, 'Reviewed') : h('span', { class: 'pill warn' }, care.review_note ? 'Flagged' : 'Not reviewed')),
        h('td', { class: 'actions' }, btn('Edit', () => open(care), 'secondary small')))))))) ;

  return h('div', { class: 'card-stack' }, queue, all);
}

// ------------------------------------------------------------------ shops

function shopsView() {
  return h('div', { class: 'card-stack' },
    h('section', { class: 'card' },
      cardHead(null, 'Shops', btn('Add a shop', () => editShop(null), 'small')),
      lede('A shop is credited for the plants added from its labels. You see counts only, never who the people are.')),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Shop', 'Prefix', 'Labels', 'Plants added', 'People', 'Watered', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, st.shops.map((s) => {
        const x = st.stats.get(s.id) || {};
        return h('tr', {},
          h('td', {}, s.name, h('div', { class: 'small muted' }, [s.area, s.slug].filter(Boolean).join(' · '))),
          h('td', { class: 'mono' }, s.prefix || h('span', { class: 'pill warn' }, 'none')),
          h('td', {}, x.labels ?? 0), h('td', {}, x.plants_added ?? 0), h('td', {}, x.people ?? 0), h('td', {}, x.plants_watered ?? 0),
          h('td', { class: 'actions' }, btn('Edit', () => editShop(s), 'secondary small')));
      })))));
}

function editShop(shop) {
  const v = { name: shop?.name || '', area: shop?.area || '', prefix: shop?.prefix || '', slug: shop?.slug || '' };
  const err = h('div', {});
  const body = h('div', { class: 'grid2' },
    h('label', { class: 'field' }, 'Shop name', h('input', { value: v.name, maxlength: 60, oninput: (e) => { v.name = e.target.value; if (!shop) { v.slug = slugify(v.name); if (!v.prefixTouched) { v.prefix = initials(v.name); body.querySelector('[name=prefix]').value = v.prefix; } } } })),
    h('label', { class: 'field' }, 'Area', h('input', { value: v.area, maxlength: 80, oninput: (e) => (v.area = e.target.value) })),
    h('label', { class: 'field' }, 'Code prefix', h('input', { name: 'prefix', class: 'mono', value: v.prefix, maxlength: 3, oninput: (e) => { v.prefix = e.target.value.toUpperCase(); v.prefixTouched = true; } }),
      h('span', { class: 'hint' }, shop?.prefix ? 'Codes already printed keep their old prefix.' : 'Three letters or digits.')),
    err);
  modal(shop ? `Edit ${shop.name}` : 'Add a shop', body, (close) => [
    btn('Save', async () => {
      if (!v.name.trim()) return err.replaceChildren(notice('error', 'Give the shop a name.'));
      if (!/^[A-Z0-9]{3}$/.test(v.prefix)) return err.replaceChildren(notice('error', 'The prefix is three letters or digits.'));
      try {
        const values = { name: v.name.trim(), area: v.area.trim() || null, prefix: v.prefix };
        if (shop) await ok(sb.from('shops').update(values).eq('id', shop.id).select().single());
        else await ok(sb.from('shops').insert({ ...values, slug: v.slug || slugify(v.name) }).select().single());
        close();
        await refreshAndRender();
      } catch (e) { err.replaceChildren(notice('error', explain(e))); }
    }),
    btn('Cancel', close, 'secondary'),
  ]);
}

// ------------------------------------------------------------------ start

/** Starts the page in `rootEl` using a Supabase client. `options.adminEmail` is the admin's address. */
export async function start(client, rootEl, options = {}) {
  sb = client;
  adminEmail = options.adminEmail || '';
  root = rootEl;
  printRoot = document.getElementById('print-root');
  st.queue = loadQueue();
  window.addEventListener('afterprint', () => printRoot?.replaceChildren());
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && st.user) {
      st.user = null;
      signInScreen('You were signed out.');
    }
  });
  const { data } = await sb.auth.getSession();
  if (data?.session) await afterSignIn();
  else signInScreen();
}

