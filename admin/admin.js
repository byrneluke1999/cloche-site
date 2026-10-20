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

const st = {
  user: null,
  tab: 'make',
  loaded: false,
  shops: [],
  care: [],
  tags: [],
  stats: new Map(),
  queue: [],
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

const btn = (text, onclick, kind = '', extra = {}) => h('button', { type: 'button', class: `btn ${kind}`.trim(), onclick, ...extra }, text);

// ------------------------------------------------------------------ sign-in

function showScreen(...nodes) {
  clearTimeout(idleTimer);
  root.replaceChildren(h('div', { class: 'centre' }, h('h1', {}, 'Cloche admin'), ...nodes));
}

function signInScreen(note) {
  let email = '';
  let sent = false;
  let busy = false;
  let message = note ? { kind: 'ok', text: note } : null;

  const draw = () => {
    const form = h('form', { class: 'card', onsubmit: submit });
    if (!sent) {
      form.append(
        h('label', { class: 'field' }, 'Email', h('input', { type: 'email', autocomplete: 'username', required: true, value: email, oninput: (e) => (email = e.target.value.trim()) })),
        notice(message?.kind, message?.text),
        h('button', { class: 'btn', type: 'submit', disabled: busy }, busy ? 'Sending…' : 'Email me a code')
      );
    } else {
      form.append(
        h('p', {}, `We sent a code to ${email}.`),
        h('label', { class: 'field' }, 'Code from the email', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', minlength: 6, maxlength: 10, required: true })),
        notice(message?.kind, message?.text),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'submit', disabled: busy }, busy ? 'Checking…' : 'Sign in'),
          btn('Use another email', () => { sent = false; message = null; draw(); }, 'secondary'))
      );
    }
    showScreen(form);
    form.querySelector('input')?.focus();
  };

  async function submit(e) {
    e.preventDefault();
    busy = true;
    message = null;
    const code = e.target.elements.code?.value.trim();
    draw();
    try {
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
      message = { kind: 'error', text: sent ? 'That code didn’t work. It may be wrong or out of date.' : explain(err) };
    }
    busy = false;
    draw();
  }

  draw();
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
];

function render() {
  if (!st.user) return;
  const view = st.tab === 'labels' ? labelsView() : st.tab === 'shops' ? shopsView() : makeView();
  const top = h('div', { class: 'top' },
    h('img', { src: '/favicon.svg', alt: '' }),
    h('h1', {}, 'Cloche admin'),
    h('span', { class: 'who' }, st.user.email),
    signOutButton()
  );
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' },
    TABS.map(([id, name]) => h('button', { type: 'button', 'aria-current': st.tab === id ? 'page' : null, onclick: () => { st.tab = id; render(); } }, name))
  );
  const scroll = window.scrollY;
  root.replaceChildren(top, tabs, h('main', {}, notice(st.banner?.kind, st.banner?.text), view), queueBar() || document.createDocumentFragment());
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
  reviewed: row?.reviewed ?? false,
});

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
    h('header', {}, h('span', { class: 'step' }, '1'), h('h2', {}, 'Which shop is the sticker for?')),
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
    h('header', {}, h('span', { class: 'step' }, '2'), h('h2', {}, 'Which plant?')),
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

function careCard(m) {
  const f = m.form;
  const row = m.care;
  const isNew = !!row.manual;
  const sources = Array.isArray(row.sources) ? row.sources : [];
  const status = isNew ? h('span', { class: 'pill warn' }, 'Not saved yet')
    : row.reviewed ? h('span', { class: 'pill ok' }, 'Reviewed') : h('span', { class: 'pill warn' }, 'Not reviewed');
  const field = (label, name, props = {}, hint) => h('label', { class: 'field' }, label,
    h('input', { value: f[name], oninput: (e) => (f[name] = e.target.value), ...props }), hint ? h('span', { class: 'hint' }, hint) : null);
  return h('section', { class: 'card' },
    h('header', {}, h('span', { class: 'step' }, '3'), h('h2', {}, `Care for ${row.species_scientific}`), status),
    !isNew ? h('p', { class: 'small muted' }, sources.length ? '' : 'No sources recorded.',
      sources.slice(0, 4).map((s, i) => [i ? ' · ' : 'Sources: ', /^https?:\/\//.test(s.url) ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || s.url) : (s.title || '')])) : null,
    h('div', { class: 'grid2' },
      field('Water every (days)', 'watering_interval_days', { type: 'number', min: 1, max: 365, step: 1, inputmode: 'numeric' }, 'The default the app suggests. People can change it.'),
      h('label', { class: 'field' }, 'Lives', h('select', { onchange: (e) => (f.typical_environment = e.target.value), value: f.typical_environment },
        h('option', { value: 'indoor' }, 'Indoors'), h('option', { value: 'outdoor' }, 'Outdoors')), h('span', { class: 'hint' }, 'How it is usually grown in Ireland and the UK.')),
      field('Common name', 'species_common', { maxlength: 60 }),
      field('Light', 'light', { maxlength: 120 }),
      field('Humidity', 'humidity', { maxlength: 120 })),
    row.toxic_to_pets !== undefined ? h('p', { class: 'small muted' }, `Toxicity (not shown in the app until verified): pets ${triState(row.toxic_to_pets)}, children ${triState(row.toxic_to_children)}.`) : null,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.reviewed, onchange: (e) => (f.reviewed = e.target.checked) }),
      h('span', {}, 'I have checked this care. Labels are only made for reviewed care, so a scan always shows something right.')),
    h('div', { class: 'row' }, btn(isNew ? 'Save care' : 'Save changes', () => saveCareClicked())),
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
    reviewed: !!f.reviewed,
  };
}

async function saveCare() {
  const m = st.make;
  const values = careValues(m.form);
  const row = m.care.manual
    ? await ok(sb.from('species_care').insert({ species_scientific: m.care.species_scientific, ...values, model: 'manual' }).select().single())
    : await ok(sb.from('species_care').update(values).eq('species_scientific', m.care.species_scientific).select().single());
  await refreshAll();
  adoptCare(row);
  m.commonName = m.commonName || row.species_common || '';
}

async function saveCareClicked() {
  const m = st.make;
  m.careMsg = null;
  try {
    await saveCare();
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
    h('header', {}, h('span', { class: 'step' }, '4'), h('h2', {}, 'The sticker')),
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
    h('header', {}, h('span', { class: 'step' }, '✓'), h('h2', {}, `Label ${tag.code} is in the database`)),
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
    h('section', { class: 'card' }, h('h2', {}, 'Labels'),
      h('div', { class: 'row' },
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

// ------------------------------------------------------------------ shops

function shopsView() {
  return h('div', { class: 'card-stack' },
    h('section', { class: 'card' },
      h('header', {}, h('h2', {}, 'Shops'), btn('Add a shop', () => editShop(null), 'small')),
      h('p', { class: 'small muted' }, 'A shop is credited for the plants added from its labels. Counts only, never names.')),
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

/** Starts the page in `rootEl` using a Supabase client. */
export async function start(client, rootEl) {
  sb = client;
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

