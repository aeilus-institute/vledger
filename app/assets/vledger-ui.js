// Value Wallet L1 UI (format aevri.vledger 1.0-d2). Plain DOM, no framework.
// Timeline of events "someone did something with something or someone", contacts with addresses and QR,
// value systems and goals, assessments with references and spent value, inbox, analytics, settings.

import { Wallet, device, passphraseOk, inspectImport, pendingRecovery, REACTIONS, biometricKeys } from './vledger-store.js';
import * as Bio from './vledger-biometric.js';
import { makeProvider, restoreCode, parseRestoreCode, AEVRI_URL, AEVRI_RELAY, AEVRI_ARBITER, AEVRI_REGISTRY, fetchRegistry, RelayClient } from './vledger-providers.js';
import * as V from './vledger-value.js';
import * as C from './vledger-crypto.js';
import { qrSvg } from './vledger-qr.js';
import { vetOpenPayload, openVet, embedForVss, vssRefOf } from './vledger-bridge.js';

const LANGS = ['en', 'ru'];
let L = {};
let lang = 'en';
let wallet = null;
// What the page was opened for (SPEC 3, 12): #vw1:... adds a contact; ?registry=<url>&item=<id> opens a work in a
// registry. Kept until a wallet is open, then done once and removed from the address bar.
let pending = readLink();

function readLink() {
  try {
    const q = new URLSearchParams(location.search);
    const reg = q.get('registry');
    if (reg && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(reg)) return { kind: 'registry', url: reg, item: (q.get('item') || '').slice(0, 100) };
    const a = C.parseAddress(decodeURIComponent(location.hash.slice(1)));
    if (a) return { address: a.address, name: a.name, contactKind: a.kind, kind: 'contact' };
  } catch { /* ignore a malformed link */ }
  return null;
}

// VET on the same site (SPEC 16.1); tests point it at a mock.
let vetUrl = null;
const vetAddress = () => vetUrl || new URL((lang === 'en' ? '' : '/' + lang) + '/tools/vet/embed.php?host=ledger', location.origin).href;

// The wallet inside VSS (SPEC 16.2): only with ?embed=vss and a parent page.
const vss = new URLSearchParams(location.search).get('embed') === 'vss' ? embedForVss({ getWallet: () => wallet, recordTransfer }) : { on: false, ready() {}, reset() {} };

async function recordTransfer(ctx) {
  tab = 'timeline'; render();
  const src = ctx.flowRef.sourceNode?.name && contacts().find((c) => c.body.name === ctx.flowRef.sourceNode.name);
  const what = ctx.item?.title || ctx.elementType?.name;
  const id = await eventDialog(null, { role: 'affected', actor: src ? src.rootId : '', action: ctx.flowRef.flowLabel || t('br.transfer'),
    objects: what ? [{ label: String(what).slice(0, 300) }] : [], vssRef: vssRefOf(ctx) });
  return id ? wallet.rootOf(id) : null;
}

async function runPending() {
  const p = pending;
  pending = null;
  try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  if (p.kind === 'contact') {
    if (p.address === wallet.address) return;
    const known = wallet.contactByAddress(p.address);
    tab = 'contacts'; render();
    if (known) { toast(t('link.known', { name: known.body.name })); return; }
    const kind = ['person', 'organization', 'state', 'group', 'device'].includes(p.contactKind) ? p.contactKind : 'person';
    await contactDialog(null, { name: p.name || '', address: p.address, type: kind });
  } else if (p.kind === 'registry') {
    tab = 'timeline'; render();
    const doc = await guard(() => fetchRegistry(p.url));
    if (doc) await showRegistry(doc, 'url', p.item);
  }
}
let tab = 'timeline';
let lifePath = []; // Life tab: [{t:'g', id}, {t:'s', id}, {t:'x', s, cp, dir}, {t:'p', cp}]
let lifeMode = 'ex', lifeMap = false, lifeSheet = null; // lifeMap: false (list) | 'events' | 'vss:<schemaId>'
let filters = { system: '', role: '', contact: '', assessed: '' };
let period = '90';
let idleTimer = null;
let notices = []; // pending recovery requests reported by providers on sync
let syncing = false;
const IDLE_MS = 15 * 60 * 1000;

// ---- i18n ----

function t(key, vars = {}) {
  let s = L[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', v);
  return s;
}

async function loadLang(code) {
  lang = LANGS.includes(code) ? code : 'en';
  L = await (await fetch(new URL('./locales/' + lang + '.json', import.meta.url), { cache: 'no-cache' })).json();
  document.documentElement.lang = lang;
  try { localStorage.setItem('vledger.lang', lang); } catch { /* storage may be blocked */ }
}

// ---- DOM helpers ----

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const $app = () => document.getElementById('app');
const pct = (x) => (Math.round(x * 1000) / 10).toLocaleString(lang) + '%';
const num = (x) => (Math.round(x * 100) / 100).toLocaleString(lang);
const today = () => new Date().toISOString().slice(0, 10);
const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 300));
const short = (a) => (a ? a.slice(0, 10) + '...' + a.slice(-4) : '');

function toast(msg) {
  const el = h('div', { class: 'vw-toast', role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

function modal(title, build) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'vw-dialog', 'aria-label': title });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h('div', { class: 'vw-dialog-head' }, h('h2', {}, title), h('button', { class: 'vw-icon', type: 'button', 'aria-label': t('close'), onclick: () => close(null) }, '×')), build(close));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input:not([type=radio]), textarea, select');
    if (first) first.focus();
  });
}

const field = (label, input, hint) => h('label', { class: 'vw-field' }, h('span', { class: 'vw-label' }, label), input, hint ? h('span', { class: 'vw-hint' }, hint) : null);
const select = (options, value) => h('select', {}, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
const submitRow = (label = t('save')) => h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, label));

async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast(t('err.generic', { msg: e.message })); return null; }
}

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickFile() {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept: '.json,application/json' });
    inp.addEventListener('change', async () => {
      const f = inp.files[0];
      if (!f) return resolve(null);
      if (f.size > 20 * 1024 * 1024) { toast(t('err.tooBig')); return resolve(null); }
      try { resolve(JSON.parse(await f.text())); } catch { toast(t('err.notJson')); resolve(null); }
    });
    inp.click();
  });
}

const slug = (s) => (s || 'wallet').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wallet';

// ---- idle lock ----

function touch() {
  clearTimeout(idleTimer);
  if (wallet) idleTimer = setTimeout(() => { lockNow(); toast(t('lock.idle')); }, IDLE_MS);
}

function lockNow() {
  if (wallet) wallet.lock();
  wallet = null;
  vss.reset();
  notices = [];
  render();
}

// ---- model helpers ----

const selfId = () => wallet.selfContact()?.rootId;
const contacts = () => wallet.list('contact');
const systems = () => wallet.list('value-system');
const systemsForValue = () => systems().map((s) => ({ id: s.rootId, W: s.body.W, status: s.body.status }));
const goalsForValue = () => wallet.list('goal').map((g) => ({ id: g.rootId, S: g.body.S, N: g.body.N ?? g.body.S, status: g.body.status, systemId: g.body.systemId, title: g.body.title }));
const events = (all = false) => wallet.list('event').filter((e) => all || e.body.status === 'confirmed');
const assessments = () => wallet.list('assessment');
// A reaction of an assessment; assessments imported before SPEC 17 kept it as an own score in reaction units
const reactionOf = (b) => (REACTIONS.includes(b?.reaction) ? b.reaction
  : (b?.ownScore && /ÆVRI/.test(b.ownScore.unit || '') && REACTIONS.includes(b.ownScore.value) ? b.ownScore.value : null));
const hasGoals = () => wallet.list('goal').some((g) => g.body.status === 'active');
const needsCalibration = (a) => reactionOf(a.body) !== null && !(a.body.contributions || []).length;

function reactionRow(evRootId, current, after) {
  return h('div', { class: 'vw-reacts', role: 'group', 'aria-label': t('rx.q') }, REACTIONS.map((v) =>
    h('button', { type: 'button', class: 'vw-react' + (v === current ? ' is-on' : '') + (v < 0 ? ' is-neg' : ''), 'aria-pressed': String(v === current),
      onclick: async () => { const id = await guard(() => wallet.react(evRootId, v)); if (id) { if (after) after(v); else { toast(t('rx.saved', { r: t('rx.' + v) })); render(); } } } }, t('rx.' + v))));
}

// The registry item behind an event (its promise and link), from the stored copy of the registry
function registryItem(ev) {
  const ref = ev.body.registryRef;
  if (!ref) return null;
  const imp = wallet.list('import').find((i) => i.body.originId === ref.registryUrl);
  return (imp?.body.payload?.registry?.items || []).find((x) => x.itemId === ref.itemId) || null;
}
const nameOf = (id) => (id === selfId() ? t('me.subj') : wallet.get(id)?.body.name || t('cp.unknown'));
const objName = (id) => (id === selfId() ? t('me.obj') : wallet.get(id)?.body.name || t('cp.unknown'));
// The registry owner is the other side of an event with a registry object (TZ v0.3 EV-3).
const involves = (e, c) => e.body.actor === c.rootId || (e.body.affected || []).includes(c.rootId) || (!!c.body.address && e.body.registryRef?.owner === c.body.address);
const withOwner = (e) => {
  const b = { id: e.rootId, ...e.body };
  const owner = b.registryRef?.owner && wallet.contactByAddress(b.registryRef.owner);
  if (owner && b.actor === selfId() && !(b.affected || []).length) b.affected = [owner.rootId];
  return b;
};
const sysTitle = (id) => (id ? wallet.get(id)?.body.title : '') || t('sys.none');
// The group of a sphere (Family, Work, States, ...): set by the holder; a sphere made from a registry falls into the
// group of the registry owner until the holder moves it
function groupOf(sys) {
  if (sys.body.group) return sys.body.group;
  if (sys.body.registryUrl) {
    const imp = wallet.list('import').find((i) => i.body.originId === sys.body.registryUrl);
    const name = imp?.body.payload?.registry?.owner?.card?.name;
    if (name) return name.replace(/^.*\((.+)\)$/, '$1');
  }
  return t('life.otherGroup');
}

// The exchange an event belongs to (Codex, Grok round 2): the other side and the direction from the holder
function exchangeOf(e) {
  const b = e.body, me = selfId();
  const owner = b.registryRef?.owner ? wallet.contactByAddress(b.registryRef.owner)?.rootId : null;
  if (b.role === 'actor') return { cp: (b.affected || []).find((x) => x !== me) || owner || null, dir: 'out' };
  if (b.role === 'user') return { cp: (b.actor && b.actor !== me ? b.actor : owner) || null, dir: 'in' };
  return { cp: b.actor && b.actor !== me ? b.actor : owner, dir: 'in' };
}

function phrase(ev) {
  const b = ev.body;
  if (b.actionType === 'registry-event') return b.action + (b.affected?.length ? ' → ' + b.affected.map(objName).join(', ') : '');
  const objs = (b.objects || []).map((o) => o.label + (o.quantity != null ? ` (${o.quantity}${o.unit ? ' ' + o.unit : ''})` : '')).join(', ');
  const aff = (b.affected || []).map(objName).join(', ');
  let s = `${nameOf(b.actor)} ${b.action}`;
  if (objs) s += ' ' + objs;
  if (aff) s += objs ? ' ' + t('phrase.with', { names: aff }) : ' ' + aff;
  return s;
}

function valueOf(contributions, spent = []) {
  return V.assessValue(goalsForValue(), systemsForValue(), contributions, spent);
}

function registryRefs(systemId) {
  const sys = systemId && wallet.get(systemId);
  if (!sys?.body.registryUrl) return [];
  const imp = wallet.list('import').find((i) => i.body.originId === sys.body.registryUrl);
  return (imp?.body.payload?.registry?.references || []).map((r) => ({ phrase: r.phrase, v: r.v, words: r.words, public: true }));
}

function referencesFor(systemId, excludeEventId) {
  const own = assessments().filter((a) => a.body.reference && typeof a.body.v === 'number' && a.body.eventId !== excludeEventId).map((a) => {
    const ev = wallet.get(a.body.eventId);
    return ev && ev.body.systemId === systemId ? { phrase: phrase(ev), v: a.body.v, public: false } : null;
  }).filter(Boolean);
  return [...own, ...registryRefs(systemId)];
}

function goalProgress(goalRootId) {
  const g = wallet.get(goalRootId);
  if (!g) return 0;
  const N = g.body.N ?? g.body.S;
  return assessments().flatMap((a) => (a.body.contributions || []).filter((c) => c.goalId === goalRootId)).reduce((s, c) => s + V.progressShare({ S: g.body.S, N }, c), 0);
}

// ---- start screen ----

// The wallet signs with Ed25519 in Web Crypto (Chrome 137+, Safari 17+, Firefox 129+); older browsers cannot create
// or open a wallet, so the start screen says so instead of hanging (found on an Android emulator with Chrome 124)
let cryptoOk = null;
async function cryptoSupport() {
  if (cryptoOk === null) {
    try { await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); cryptoOk = true; } catch { cryptoOk = false; }
  }
  return cryptoOk;
}

async function renderStart() {
  const list = await guard(() => device.list()) || [];
  const box = h('div', { class: 'vw-start' },
    (await cryptoSupport()) ? null : h('div', { class: 'vw-card vw-alert', role: 'alert' }, h('strong', {}, t('start.oldBrowserTitle')), h('p', {}, t('start.oldBrowser'))),
    h('p', { class: 'vw-lead' }, t('start.lead')),
    h('ul', { class: 'vw-facts' }, h('li', {}, t('start.f1')), h('li', {}, t('start.f2')), h('li', {}, t('start.f3'))));
  if (pending) box.prepend(h('div', { class: 'vw-card vw-notice', role: 'status' }, pending.kind === 'contact'
    ? t('link.contact', { name: pending.name || short(pending.address) }) : t('link.registry', { host: new URL(pending.url).host })));
  if (list.length) {
    box.append(h('h2', {}, t('start.onDevice')));
    for (const w of list) {
      box.append(h('div', { class: 'vw-card vw-row' },
        h('div', {}, h('strong', {}, w.label || t('start.unnamed')), h('div', { class: 'vw-muted' }, t('start.records', { n: w.records, date: w.createdAt.slice(0, 10) }))),
        h('button', { class: 'vw-btn', onclick: () => unlockDialog(w.walletId, w.label) }, t('start.open'))));
    }
  }
  const pend = await guard(() => pendingRecovery.list()) || [];
  if (pend.length) {
    box.append(h('h2', {}, t('fg.pending')));
    for (const rq of pend) box.append(h('div', { class: 'vw-card vw-row' }, h('span', {}, t('fg.pendingLine', { ready: (rq.readyAfter || '').replace('T', ' ').slice(0, 16) })),
      h('button', { class: 'vw-btn', onclick: () => checkRecovery(rq) }, t('fg.check'))));
  }
  box.append(h('div', { class: 'vw-actions' },
    h('button', { class: 'vw-btn vw-primary', onclick: createDialog }, t('start.create')),
    h('button', { class: 'vw-btn', onclick: importDialog }, t('start.import')),
    h('button', { class: 'vw-btn', onclick: restoreDialog }, t('rs.title')),
    h('button', { class: 'vw-btn vw-ghost', onclick: forgotDialog }, t('fg.title'))));
  return box;
}

function unlockDialog(walletId, label, doc) {
  return modal(t('unlock.title', { name: label || t('start.unnamed') }), (close) => {
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    const btn = h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('unlock.go'));
    // device biometrics first when this wallet has them here (SPEC 18); the passphrase always works
    const bioBox = h('div', {});
    if (Bio.available() && !doc) {
      biometricKeys.get(walletId).then((rec) => {
        if (!rec) return;
        const bioBtn = h('button', { type: 'button', class: 'vw-btn vw-primary vw-bio' }, t('bio.unlock'));
        bioBtn.addEventListener('click', async () => {
          bioBtn.disabled = true; msg.textContent = t('bio.wait');
          try {
            const d = await device.get(walletId);
            wallet = await Wallet.openWithDek(d, await Bio.unlockKey(rec));
            close(true); touch(); render(); syncAll(true);
          } catch { msg.textContent = t('bio.failed'); bioBtn.disabled = false; }
        });
        bioBox.replaceChildren(bioBtn, h('p', { class: 'vw-muted vw-small' }, t('bio.orPass')));
        btn.classList.remove('vw-primary');
      }).catch(() => {});
    }
    return h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; msg.textContent = t('unlock.wait');
      try {
        wallet = await Wallet.unlock(doc || await device.get(walletId), pass.value);
        pass.value = '';
        close(true); touch(); render(); syncAll(true);
      } catch { msg.textContent = t('unlock.wrong'); btn.disabled = false; }
    } }, bioBox, field(t('unlock.pass'), pass), msg, h('div', { class: 'vw-actions' }, btn));
  });
}

function createDialog() {
  return modal(t('create.title'), (close) => {
    const label = h('input', { type: 'text', maxlength: 100, placeholder: t('create.labelPh') });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const ack = h('input', { type: 'checkbox' });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    const btn = h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('create.go'));
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!passphraseOk(p1.value)) { msg.textContent = t('create.weak'); return; }
      if (p1.value !== p2.value) { msg.textContent = t('create.mismatch'); return; }
      if (!ack.checked) { msg.textContent = t('create.ackNeeded'); return; }
      btn.disabled = true; msg.textContent = t('create.wait');
      // errors are shown in the dialog itself: a toast would sit behind the modal (Android pilot, 2026-10-18)
      try { wallet = await Wallet.create(p1.value, { label: label.value.trim() }); }
      catch (err) { console.error(err); wallet = null; msg.textContent = (await cryptoSupport()) ? t('err.generic', { msg: err.message }) : t('start.oldBrowser'); }
      p1.value = p2.value = '';
      if (wallet) { close(true); touch(); tab = 'timeline'; render(); } else btn.disabled = false;
    } },
    field(t('create.label'), label, t('create.labelHint')),
    field(t('create.pass'), p1, t('create.passHint')),
    field(t('create.pass2'), p2),
    h('label', { class: 'vw-check' }, ack, h('span', {}, t('create.ack'))),
    msg, h('div', { class: 'vw-actions' }, btn));
  });
}

async function importDialog() {
  const doc = await pickFile();
  if (!doc) return;
  if (doc.type === 'aevri.vledger.message') { if (wallet) await receiveMessage(doc); else toast(t('import.openFirst')); return; }
  const ins = await inspectImport(doc);
  if (!ins.ok) { toast(t('import.bad')); return; }
  if (ins.chain.length) toast(t('import.chain', { n: ins.chain.length }));
  const existing = await device.get(doc.walletId);
  if (existing) {
    await unlockDialog(doc.walletId, existing.extensions?.label);
    if (wallet && wallet.id === doc.walletId) {
      const r = await guard(() => wallet.merge(doc));
      if (r) { toast(t('import.merged', { a: r.added, e: r.erased })); render(); }
    }
    return;
  }
  await unlockDialog(doc.walletId, doc.extensions?.label, doc);
  if (wallet && wallet.id === doc.walletId) { await wallet.save(); toast(t('import.saved')); render(); }
}

// ---- providers and sync (L2) ----

async function checkMessages(quiet = true) {
  if (!wallet || !wallet.relayUrl()) return;
  try {
    const r = await wallet.checkInbox();
    if (r.received || r.matched || !quiet) toast(t('rl.checked', { n: r.received, m: r.matched }));
    if (r.received || r.matched) render();
  } catch (e) { console.warn(e); if (!quiet) toast(t('rl.failed', { msg: e.message })); }
}

async function syncAll(quiet = false) {
  if (!wallet || syncing) return;
  checkMessages(true);
  const list = wallet.providers();
  if (!list.length) return;
  syncing = true;
  const found = [];
  let errors = 0;
  for (const cfg of list) {
    try {
      const r = await wallet.syncWith(cfg);
      found.push(...r.notices.map((n) => ({ ...n, cfg })));
    } catch (e) { console.warn(e); errors++; }
  }
  syncing = false;
  notices = found;
  if (!quiet || errors || found.length) toast(errors ? t('pv.syncErrors', { n: errors }) : t('pv.synced'));
  render();
}

function providerLabel(cfg) {
  if (cfg.kind === 'aevri') return t('pv.kind.aevri');
  if (cfg.kind === 'github') return `GitHub ${cfg.config.owner}/${cfg.config.repo}`;
  return cfg.url;
}

function noticeBanner() {
  if (!notices.length) return null;
  return h('div', { class: 'vw-card vw-alert', role: 'alert' }, notices.map((n) => h('div', {},
    h('strong', {}, t('pv.noticeTitle')), h('p', {}, t('pv.notice', { at: n.createdAt.replace('T', ' ').slice(0, 16), ready: n.readyAfter.replace('T', ' ').slice(0, 16), where: providerLabel(n.cfg) })),
    h('button', { class: 'vw-btn vw-danger', onclick: async () => {
      await guard(() => makeProvider(n.cfg).cancelRecovery(n.requestId, wallet.session));
      notices = notices.filter((x) => x.requestId !== n.requestId);
      toast(t('pv.cancelled')); render();
    } }, t('pv.cancelRecovery')))));
}

function providerDialog() {
  return modal(t('pv.addTitle'), (close) => {
    const kind = select([['aevri', t('pv.kind.aevri')], ['github', t('pv.kind.github')], ['custom', t('pv.kind.custom')]], 'aevri');
    const url = h('input', { type: 'url', placeholder: 'https://', value: '' });
    const owner = h('input', { type: 'text', placeholder: 'owner' });
    const repo = h('input', { type: 'text', placeholder: 'private-repo' });
    const branch = h('input', { type: 'text', value: 'main' });
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'github_pat_...' });
    const age = h('input', { type: 'checkbox' });
    const boxA = h('div', {}, h('p', { class: 'vw-hint' }, t('pv.aevriHint')), h('label', { class: 'vw-check' }, age, h('span', {}, t('pv.age'))));
    const boxG = h('div', { hidden: true }, h('p', { class: 'vw-hint' }, t('pv.githubHint')),
      h('div', { class: 'vw-inline' }, field(t('pv.owner'), owner), field(t('pv.repo'), repo), field(t('pv.branch'), branch)),
      field(t('pv.token'), token, t('pv.tokenHint')));
    const boxC = h('div', { hidden: true }, field(t('pv.url'), url, t('pv.urlHint')));
    kind.addEventListener('change', () => { boxA.hidden = kind.value !== 'aevri'; boxG.hidden = kind.value !== 'github'; boxC.hidden = kind.value !== 'custom'; });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    const btn = h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('pv.addGo'));
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const id = 'p-' + Date.now().toString(36);
      let cfg;
      if (kind.value === 'aevri') {
        if (!age.checked) { msg.textContent = t('pv.ageNeeded'); return; }
        cfg = { id, kind: 'aevri', url: AEVRI_URL, ageConfirmed: true };
      } else if (kind.value === 'github') {
        if (!owner.value.trim() || !repo.value.trim() || !token.value.trim()) { msg.textContent = t('pv.githubNeed'); return; }
        cfg = { id, kind: 'github', config: { owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', token: token.value.trim() } };
      } else {
        if (!/^https:\/\/|^http:\/\/127\.0\.0\.1|^http:\/\/localhost/.test(url.value)) { msg.textContent = t('pv.urlNeed'); return; }
        cfg = { id, kind: 'custom', url: url.value.trim().replace(/\/$/, '') };
      }
      btn.disabled = true; msg.textContent = t('pv.connecting');
      try {
        await wallet.syncWith(cfg);
        await wallet.saveProvider(cfg);
        token.value = '';
        close(true); toast(t('pv.added')); render();
      } catch (err) {
        msg.textContent = err.code === 'vledger/sign-in' ? t('pv.signIn') : t('pv.failed', { msg: err.message });
        btn.disabled = false;
      }
    } }, field(t('pv.kind'), kind), boxA, boxG, boxC, msg, h('div', { class: 'vw-actions' }, btn));
  });
}

function providersSection() {
  const list = wallet.providers();
  const last = wallet.doc.extensions.lastSync || {};
  return [
    h('h2', {}, t('set.storage')), h('p', { class: 'vw-hint' }, t('pv.lead')),
    list.length ? list.map((cfg) => h('article', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('strong', {}, providerLabel(cfg)), h('span', { class: 'vw-muted vw-small' }, last[cfg.id] ? t('pv.last', { at: last[cfg.id].replace('T', ' ').slice(0, 16) }) : t('pv.never'))),
      h('p', { class: 'vw-small' }, t('pv.code'), ' ', h('code', { class: 'vw-addr' }, restoreCode(cfg, wallet.id))),
      cfg.recovery ? h('p', { class: 'vw-flag' }, t('pv.recoveryOn')) : null,
      h('div', { class: 'vw-actions' },
        h('button', { class: 'vw-btn', onclick: async () => { const r = await guard(() => wallet.syncWith(cfg)); if (r) { notices = r.notices.map((n) => ({ ...n, cfg })); toast(t('pv.syncResult', { up: r.up, down: r.down })); render(); } } }, t('pv.syncNow')),
        h('button', { class: 'vw-btn vw-ghost', onclick: async () => { try { await navigator.clipboard.writeText(restoreCode(cfg, wallet.id)); toast(t('copied')); } catch { prompt(t('ct.copyManual'), restoreCode(cfg, wallet.id)); } } }, t('pv.copyCode')),
        cfg.kind !== 'github' ? (cfg.recovery
          ? h('button', { class: 'vw-btn vw-ghost', onclick: async () => { if (confirm(t('pv.recoveryOffConfirm'))) { await guard(() => wallet.disableRecovery(cfg)); toast(t('pv.recoveryOff')); render(); } } }, t('pv.recoveryOffBtn'))
          : h('button', { class: 'vw-btn vw-ghost', onclick: () => recoveryDialog(cfg) }, t('pv.recoveryOnBtn'))) : null,
        h('button', { class: 'vw-btn vw-ghost vw-danger', onclick: async () => {
          if (!confirm(t('pv.removeConfirm'))) return;
          if (await guard(() => makeProvider(cfg).deleteWallet(wallet.id, wallet.session))) { await wallet.removeProviderConfig(cfg.id); toast(t('pv.removed')); render(); }
        } }, t('pv.remove'))))) : h('p', { class: 'vw-muted' }, t('pv.none')),
    h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', onclick: providerDialog }, t('pv.add'))),
    h('p', { class: 'vw-hint' }, t('set.storageHint')),
  ];
}

async function recoveryDialog(cfg) {
  const offer = await guard(() => makeProvider(cfg).recoveryOffer());
  if (!offer) { toast(t('pv.noOffer')); return; }
  return modal(t('pv.recoveryTitle'), (close) => {
    const ack = h('input', { type: 'checkbox' });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!ack.checked) { msg.textContent = t('create.ackNeeded'); return; }
      if (await guard(() => wallet.enableRecovery(cfg))) { close(true); toast(t('pv.recoveryEnabled')); render(); }
    } },
    h('p', {}, t('pv.recoveryExplain', { days: Math.round(offer.delayDays * 10) / 10, notify: offer.notifies.map((x) => t('pv.notify.' + x)).join(', ') })),
    h('p', { class: 'vw-flag' }, t('pv.canRead')),
    h('p', { class: 'vw-small' }, h('a', { href: offer.procedureUrl, target: '_blank', rel: 'noopener' }, t('pv.procedure'))),
    h('label', { class: 'vw-check' }, ack, h('span', {}, t('pv.recoveryAck'))), msg, submitRow(t('pv.recoveryOnBtn')));
  });
}

// Start screen: restore a copy, or recover a forgotten passphrase through a provider
function restoreDialog() {
  return modal(t('rs.title'), (close) => {
    const code = h('input', { type: 'text', placeholder: 'aevri:https://...#...' });
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: t('rs.tokenPh') });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    const btn = h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('rs.go'));
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const rc = parseRestoreCode(code.value);
      if (!rc) { msg.textContent = t('rs.badCode'); return; }
      if (rc.kind === 'github') rc.config.token = token.value.trim();
      btn.disabled = true; msg.textContent = t('unlock.wait');
      try {
        wallet = await Wallet.restore(rc, rc.walletId, pass.value);
        pass.value = '';
        const cfg = { id: 'p-' + Date.now().toString(36), ...rc };
        delete cfg.walletId;
        if (!wallet.providers().some((x) => restoreCode(x, wallet.id) === restoreCode(cfg, wallet.id))) await wallet.saveProvider(cfg);
        close(true); touch(); toast(t('rs.done')); render();
      } catch (err) { msg.textContent = t('rs.failed', { msg: err.message }); btn.disabled = false; }
    } }, field(t('rs.code'), code, t('rs.codeHint')), field(t('rs.token'), token, t('rs.tokenHint')), field(t('unlock.pass'), pass), msg, h('div', { class: 'vw-actions' }, btn));
  });
}

function forgotDialog() {
  return modal(t('fg.title'), (close) => {
    const code = h('input', { type: 'text', placeholder: 'aevri:https://...#...' });
    const contact = h('input', { type: 'text', maxlength: 200 });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const rc = parseRestoreCode(code.value);
      if (!rc || rc.kind === 'github') { msg.textContent = t('fg.badCode'); return; }
      try {
        const p = makeProvider(rc);
        const kr = await p.getKeyring(rc.walletId);
        const slot = kr?.slots.find((x) => x.kind === 'provider-recovery');
        if (!slot) { msg.textContent = t('fg.noSlot'); return; }
        const r = await p.requestRecovery(rc.walletId, slot.id, contact.value.trim());
        await pendingRecovery.put({ requestId: r.requestId, walletId: rc.walletId, cfg: { kind: rc.kind, url: rc.url }, privateKey: r.privateKey, readyAfter: r.readyAfter, createdAt: new Date().toISOString() });
        close(true); toast(t('fg.filed', { ready: r.readyAfter.replace('T', ' ').slice(0, 16) })); render();
      } catch (err) { msg.textContent = t('rs.failed', { msg: err.message }); }
    } }, h('p', {}, t('fg.lead')), field(t('rs.code'), code, t('rs.codeHint')), field(t('fg.contact'), contact, t('fg.contactHint')), msg, submitRow(t('fg.go')));
  });
}

async function checkRecovery(rq) {
  const r = await guard(() => makeProvider(rq.cfg).pollRecovery(rq.requestId, rq.privateKey));
  if (!r) return;
  if (r.status === 'cancelled' || r.status === 'released' || r.status === 'unknown') { await pendingRecovery.remove(rq.requestId); toast(t('fg.status.' + r.status)); render(); return; }
  if (r.status !== 'ready') { toast(t('fg.waiting', { ready: (r.readyAfter || '').replace('T', ' ').slice(0, 16) })); return; }
  await modal(t('fg.newTitle'), (close) => {
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!passphraseOk(p1.value)) { msg.textContent = t('create.weak'); return; }
      if (p1.value !== p2.value) { msg.textContent = t('create.mismatch'); return; }
      msg.textContent = t('create.wait');
      wallet = await guard(() => Wallet.recoverWithDek(rq.cfg, rq.walletId, r.dek, p1.value));
      p1.value = p2.value = '';
      await pendingRecovery.remove(rq.requestId);
      notices = [];
      if (wallet) { await wallet.save(); close(true); touch(); toast(t('fg.recovered')); render(); }
    } }, h('p', {}, t('fg.newLead')), field(t('create.pass'), p1, t('create.passHint')), field(t('create.pass2'), p2), msg, submitRow());
  });
}

// ---- tabs ----

// Main tabs (owner, 2026-10-18, after review with Grok Heavy and Codex): Log, Life, Review; the rest under More
const TABS = ['timeline', 'life', 'review', 'more'];
const MORE = ['contacts', 'systems', 'analytics', 'inbox', 'settings'];

function renderWallet() {
  const inboxCount = events(true).filter((e) => e.body.status === 'suggested').length + wallet.list('message-in').filter((m) => m.body.state === 'new').length;
  const assessedIds = new Set(assessments().map((a) => a.body.eventId));
  const openCount = events().filter((e) => !assessedIds.has(e.rootId)).length;
  const current = MORE.includes(tab) ? 'more' : tab;
  const nav = h('nav', { class: 'vw-tabs', role: 'tablist' }, TABS.map((k) =>
    h('button', { role: 'tab', 'aria-selected': String(current === k), class: current === k ? 'is-on' : '', onclick: () => { tab = k; if (k === 'life') lifePath = []; render(); } },
      t('tab.' + k), k === 'review' && openCount ? h('span', { class: 'vw-badge' }, String(openCount)) : null,
      k === 'more' && inboxCount ? h('span', { class: 'vw-badge' }, String(inboxCount)) : null)));
  const views = { timeline: tabTimeline, life: tabLife, review: tabReview, more: tabMore, contacts: tabContacts, systems: tabSystems, analytics: tabAnalytics, inbox: tabInbox, settings: tabSettings };
  const body = views[tab]();
  const back = MORE.includes(tab) ? h('button', { class: 'vw-path', onclick: () => { tab = 'more'; render(); } }, '‹ ' + t('tab.more')) : null;
  return h('div', {}, noticeBanner(), nav, h('section', { class: 'vw-panel', role: 'tabpanel' }, back, body));
}

function tabMore() {
  const inboxCount = events(true).filter((e) => e.body.status === 'suggested').length + wallet.list('message-in').filter((m) => m.body.state === 'new').length;
  return h('div', { class: 'vw-list' }, MORE.map((k) => h('button', { class: 'vw-lrow', onclick: () => { tab = k; render(); } },
    h('span', { class: 'vw-lmain' }, t('tab.' + k)), k === 'inbox' && inboxCount ? h('span', { class: 'vw-badge' }, String(inboxCount)) : null, h('span', { class: 'vw-chev', 'aria-hidden': 'true' }, '›'))));
}

function tabReview() {
  const assessedIds = new Set(assessments().map((a) => a.body.eventId));
  const open = events().filter((e) => !assessedIds.has(e.rootId)).sort((a, b) => String(b.body.occurredAt).localeCompare(String(a.body.occurredAt)));
  const calib = hasGoals() ? assessments().filter(needsCalibration) : [];
  const as = assessments();
  return [
    h('div', { class: 'vw-card' },
      h('p', { class: 'vw-lead' }, open.length ? t('q.left', { n: open.length }) : t('rv.none')),
      open.length ? h('button', { class: 'vw-btn vw-primary', onclick: () => queueDialog(open.map((e) => e.rootId)) }, t('q.go')) : null),
    calib.length ? h('div', { class: 'vw-card' }, h('p', {}, t('cal.left', { n: calib.length })), h('button', { class: 'vw-btn', onclick: () => calibrate(calib) }, t('cal.go'))) : null,
    open.slice(0, 20).map((e) => eventCard(e, as)),
  ];
}

// ---- life: Life > Group > Sphere > Exchange > Event (owner, 2026-10-18) ----

function lifeStats(evs) {
  const rxs = assessments().map((a) => ({ eventId: a.body.eventId, phase: a.body.phase, reaction: reactionOf(a.body), createdAt: a.createdAt })).filter((r) => r.reaction !== null);
  const ids = new Set(assessments().map((a) => a.body.eventId));
  const st = V.reactionStats(evs.map((e) => ({ id: e.rootId, occurredAt: e.body.occurredAt, systemId: e.body.systemId })), rxs);
  return { events: evs.length, assessed: evs.filter((e) => ids.has(e.rootId)).length, rx: st.total };
}

function lifeKpis(evs) {
  const s = lifeStats(evs), T = s.rx;
  const useful = T.assessed < 10 ? String(T.useful) : Math.round((T.useful / T.assessed) * 100) + '%';
  return h('div', { class: 'vw-kpis vw-kpis3' },
    h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, `${s.assessed} / ${s.events}`), h('div', { class: 'vw-muted' }, t('life.k.assessed'))),
    h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, T.assessed ? useful : '-'), h('div', { class: 'vw-muted' }, t('life.k.useful'))),
    h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, String(T.wasted)), h('div', { class: 'vw-muted' }, t('life.k.wasted'))));
}

const coverBar = (evs) => {
  const ids = new Set(assessments().map((a) => a.body.eventId));
  const p = evs.length ? Math.round((evs.filter((e) => ids.has(e.rootId)).length / evs.length) * 100) : 0;
  return h('span', { class: 'vw-cover', title: p + '%' }, h('i', { style: `width:${p}%` }));
};
const lrow = (main, sub, onclick, extra) => h('button', { class: 'vw-lrow', onclick }, extra || null,
  h('span', { class: 'vw-lmain' }, main, sub ? h('small', {}, sub) : null), h('span', { class: 'vw-chev', 'aria-hidden': 'true' }, '›'));
const evWord = (n) => t(n === 1 ? 'life.ev1' : 'life.evN', { n });

function lifeTitle(p) {
  if (!p) return t('life.title');
  if (p.t === 'g') return p.id;
  if (p.t === 's') return sysTitle(p.id);
  if (p.t === 'x') return p.dir === 'in' ? t('life.x.in', { name: nameOf(p.cp) }) : t('life.x.out', { name: nameOf(p.cp) });
  if (p.t === 'p') return nameOf(p.cp);
  return '';
}

function lifeHead() {
  const cur = lifePath[lifePath.length - 1];
  const out = [];
  if (cur) {
    const parent = lifePath.length > 1 ? lifeTitle(lifePath[lifePath.length - 2]) : t('life.title');
    out.push(h('button', { class: 'vw-path', 'aria-expanded': String(lifeSheet === 'up'), onclick: () => { lifeSheet = lifeSheet === 'up' ? null : 'up'; render(); } }, '‹ ' + parent + ' ', h('span', { class: 'vw-muted' }, '⌃')));
    if (lifeSheet === 'up') out.push(h('div', { class: 'vw-sheet' }, [null, ...lifePath.slice(0, -1)].map((p, i) =>
      h('button', { class: 'vw-lrow', onclick: () => { lifePath = lifePath.slice(0, i); lifeSheet = null; render(); } }, h('span', { class: 'vw-lmain' }, lifeTitle(p))))));
  }
  const siblings = cur?.t === 's' ? systems().filter((s) => s.body.status === 'active' && groupOf(s) === groupOf(wallet.get(cur.id) || { body: {} }) && s.rootId !== cur.id) : [];
  out.push(h('h2', { class: 'vw-ltitle' }, lifeTitle(cur), siblings.length ? h('button', { class: 'vw-link', 'aria-label': t('life.siblings'), onclick: () => { lifeSheet = lifeSheet === 'sib' ? null : 'sib'; render(); } }, ' ▾') : null));
  if (lifeSheet === 'sib' && siblings.length) out.push(h('div', { class: 'vw-sheet' }, siblings.map((s) => h('button', { class: 'vw-lrow', onclick: () => { lifePath[lifePath.length - 1] = { t: 's', id: s.rootId }; lifeSheet = null; render(); } }, h('span', { class: 'vw-lmain' }, s.body.title)))));
  return out;
}

const goLife = (p) => { lifePath.push(p); lifeSheet = null; lifeMode = 'ex'; lifeMap = false; render(); };

function tabLife() {
  const cur = lifePath[lifePath.length - 1];
  const all = events();
  const out = [lifeHead()];
  if (!cur) {
    const groups = new Map();
    for (const s of systems().filter((x) => x.body.status === 'active')) {
      const g = groupOf(s);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    out.push(lifeKpis(all));
    for (const [g, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ids = new Set(list.map((s) => s.rootId));
      const evs = all.filter((e) => ids.has(e.body.systemId));
      out.push(lrow(g, t('life.groupSub', { s: list.length, e: evWord(evs.length) }), () => goLife({ t: 'g', id: g }), coverBar(evs)));
    }
    const loose = all.filter((e) => !e.body.systemId || !wallet.get(e.body.systemId));
    if (loose.length) out.push(lrow(t('life.unsorted'), evWord(loose.length), () => goLife({ t: 's', id: '' }), coverBar(loose)));
    if (!systems().length) out.push(h('p', { class: 'vw-hint' }, t('life.empty')));
    return out;
  }
  if (cur.t === 'g') {
    const list = systems().filter((s) => s.body.status === 'active' && groupOf(s) === cur.id);
    out.push(lifeKpis(all.filter((e) => list.some((s) => s.rootId === e.body.systemId))));
    for (const s of list) {
      const evs = all.filter((e) => e.body.systemId === s.rootId);
      const sides = new Set(evs.map((e) => exchangeOf(e).cp).filter(Boolean));
      out.push(lrow(s.body.title, t('life.sphereSub', { p: sides.size, e: evWord(evs.length) }), () => goLife({ t: 's', id: s.rootId }), coverBar(evs)));
    }
    return out;
  }
  if (cur.t === 's') return out.concat(lifeSphere(cur.id, all));
  if (cur.t === 'x') {
    const evs = all.filter((e) => (e.body.systemId || '') === cur.s && (() => { const x = exchangeOf(e); return x.cp === cur.cp && x.dir === cur.dir; })())
      .sort((a, b) => String(b.body.occurredAt).localeCompare(String(a.body.occurredAt)));
    out.push(lifeKpis(evs), evs.map((e) => eventCard(e, assessments())));
    if (cur.cp) out.push(h('button', { class: 'vw-link', onclick: () => goLife({ t: 'p', cp: cur.cp }) }, t('life.aboutSide', { name: nameOf(cur.cp) })));
    return out;
  }
  if (cur.t === 'p') {
    const evs = all.filter((e) => exchangeOf(e).cp === cur.cp);
    out.push(lifeKpis(evs));
    const spheres = [...new Set(evs.map((e) => e.body.systemId || ''))];
    out.push(h('h3', {}, t('life.inSpheres')));
    for (const sid of spheres) {
      const se = evs.filter((e) => (e.body.systemId || '') === sid);
      out.push(lrow(sid ? sysTitle(sid) : t('life.unsorted'), evWord(se.length), () => goLife({ t: 's', id: sid }), coverBar(se)));
    }
    return out;
  }
  return out;
}

// A sphere: exchanges (default, as a list with arrows or a map with me on the left), events, goals
function lifeSphere(sid, all) {
  const evs = all.filter((e) => (e.body.systemId || '') === sid && (sid || !e.body.systemId || !wallet.get(e.body.systemId)));
  const ex = new Map();
  for (const e of evs) {
    const x = exchangeOf(e);
    const k = (x.cp || '') + '|' + x.dir;
    if (!ex.has(k)) ex.set(k, { cp: x.cp, dir: x.dir, evs: [] });
    ex.get(k).evs.push(e);
  }
  const list = [...ex.values()].sort((a, b) => b.evs.length - a.evs.length);
  const seg = h('div', { class: 'vw-seg', role: 'tablist' }, ['ex', 'ev', 'gl'].map((m) =>
    h('button', { role: 'tab', 'aria-selected': String(lifeMode === m), class: lifeMode === m ? 'is-on' : '', onclick: () => { lifeMode = m; render(); } }, t('life.m.' + m))));
  const out = [lifeKpis(evs), seg];
  if (lifeMode === 'ev') {
    out.push(evs.sort((a, b) => String(b.body.occurredAt).localeCompare(String(a.body.occurredAt))).map((e) => eventCard(e, assessments())));
  } else if (lifeMode === 'gl') {
    const goals = wallet.list('goal').filter((g) => g.body.systemId === sid && g.body.status === 'active');
    out.push(goals.length ? goals.map((g) => h('div', { class: 'vw-lrow vw-static' }, h('span', { class: 'vw-lmain' }, g.body.title, g.body.why ? h('small', {}, g.body.why) : null)))
      : h('p', { class: 'vw-hint' }, t('life.noGoals')));
    if (sid) out.push(h('button', { class: 'vw-btn', onclick: () => goalDialog() }, t('life.addGoal')));
  } else {
    const sys = sid ? wallet.get(sid) : null;
    const linked = sys?.body.vss || [];
    const views = [[false, t('life.asList')], ['events', t('life.asMap')], ...linked.map((x) => ['vss:' + x.schemaId, t('vss.view', { title: x.title })])];
    out.push(h('div', { class: 'vw-chiprow' }, views.map(([k, label]) => h('button', { class: 'vw-fchip' + (lifeMap === k ? ' is-on' : ''), onclick: () => { lifeMap = k; render(); } }, label)),
      sid ? h('button', { class: 'vw-fchip vw-ghost', onclick: () => linkSchemaDialog(sid) }, t('vss.link')) : null));
    if (typeof lifeMap === 'string' && lifeMap.startsWith('vss:')) out.push(schemaMap(sys, lifeMap.slice(4), evs));
    else if (lifeMap) out.push(sphereMap(list.slice(0, 10)));
    else {
      const shown = list.slice(0, 7);
      out.push(shown.map((x) => lrow(x.dir === 'in' ? t('life.x.in', { name: x.cp ? nameOf(x.cp) : t('cp.unknown') }) : t('life.x.out', { name: x.cp ? nameOf(x.cp) : t('cp.unknown') }),
        evWord(x.evs.length), () => goLife({ t: 'x', s: sid, cp: x.cp, dir: x.dir }), h('span', { class: 'vw-dir ' + (x.dir === 'in' ? 'is-in' : 'is-out'), 'aria-hidden': 'true' }, x.dir === 'in' ? '↙' : '↗'))));
      if (list.length > shown.length) out.push(h('details', {}, h('summary', { class: 'vw-link' }, t('life.allSides', { n: list.length })),
        list.slice(shown.length).map((x) => lrow((x.dir === 'in' ? '↙ ' : '↗ ') + (x.cp ? nameOf(x.cp) : t('cp.unknown')), evWord(x.evs.length), () => goLife({ t: 'x', s: sid, cp: x.cp, dir: x.dir })))));
      if (!list.length) out.push(h('p', { class: 'vw-hint' }, t('life.noEvents')));
    }
  }
  return out;
}

// Map of a sphere (Grok and Codex, round 2): me in a fixed left column, sides as rows on the right, separate
// in and out arrows of fixed width with the number of events; at most 5 sides, the rest stays in the list
function sphereMap(list) {
  const sides = [...new Set(list.map((x) => x.cp))].slice(0, 5);
  if (!sides.length) return h('p', { class: 'vw-hint' }, t('life.noEvents'));
  const H = Math.max(120, sides.length * 52 + 16), mid = H / 2;
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
  const svg = el('svg', { viewBox: `0 0 360 ${H}`, width: '100%', role: 'img', 'aria-label': t('life.mapLabel') });
  const defs = el('defs', {});
  for (const [id, col] of [['vwa-in', 'var(--av-success)'], ['vwa-out', 'var(--av-accent)']]) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M2 1L8 5L2 9', fill: 'none', stroke: col, 'stroke-width': '1.6' }));
    defs.append(m);
  }
  svg.append(defs);
  const me = el('g', {});
  me.append(el('rect', { x: '4', y: String(mid - 22), width: '70', height: '44', rx: '8', class: 'vw-node-me' }), el('text', { x: '39', y: String(mid), 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'vw-node-t' }, t('me.subj')));
  svg.append(me);
  sides.forEach((cp, i) => {
    const y = 8 + i * 52 + 22;
    const inn = list.find((x) => x.cp === cp && x.dir === 'in'), out = list.find((x) => x.cp === cp && x.dir === 'out');
    if (inn) {
      svg.append(el('line', { x1: '226', y1: String(y - 6), x2: '78', y2: String(mid - 6), stroke: 'var(--av-success)', 'stroke-width': '1.6', 'marker-end': 'url(#vwa-in)' }));
      svg.append(el('text', { x: '160', y: String((y - 6 + mid - 6) / 2 - 5), 'text-anchor': 'middle', class: 'vw-node-n' }, String(inn.evs.length)));
    }
    if (out) {
      svg.append(el('line', { x1: '78', y1: String(mid + 6), x2: '226', y2: String(y + 6), stroke: 'var(--av-accent)', 'stroke-width': '1.6', 'marker-end': 'url(#vwa-out)' }));
      svg.append(el('text', { x: '160', y: String((y + 6 + mid + 6) / 2 + 13), 'text-anchor': 'middle', class: 'vw-node-n' }, String(out.evs.length)));
    }
    const g = el('g', { class: 'vw-node', tabindex: '0', role: 'button' });
    g.append(el('rect', { x: '230', y: String(y - 17), width: '126', height: '34', rx: '7' }), el('text', { x: '293', y: String(y), 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'vw-node-t' }, (cp ? nameOf(cp) : t('cp.unknown')).slice(0, 18)));
    g.addEventListener('click', () => goLife({ t: 'p', cp }));
    svg.append(g);
  });
  return h('div', { class: 'vw-map' }, svg, h('p', { class: 'vw-muted vw-small' }, t('life.mapHint')));
}

// ---- a sphere's VSS schema seen from the holder (SPEC 19, D-37) ----

function schemaMap(sys, schemaId, evs) {
  const link = (sys?.body.vss || []).find((x) => x.schemaId === schemaId);
  const doc = wallet.schemaDoc(schemaId);
  if (!link || !doc) return h('p', { class: 'vw-hint' }, t('vss.missing'));
  const me = link.holderNodeId;
  const node = (id) => doc.nodes.find((n) => n.id === id);
  const flows = doc.flows.filter((f) => f.source_node_id === me || f.target_node_id === me);
  const count = new Map();
  for (const e of evs) { const fid = e.body.vssRef?.vssSchemaId === schemaId ? e.body.vssRef.flowId : null; if (fid) count.set(fid, (count.get(fid) || 0) + 1); }
  // neighbours: nodes on the other end of my flows; external flows (no node) are grouped as "outside"
  const sides = [];
  for (const f of flows) {
    const other = f.source_node_id === me ? f.target_node_id : f.source_node_id;
    const key = other || '__ext';
    if (!sides.includes(key)) sides.push(key);
  }
  const shown = sides.slice(0, 5);
  const H = Math.max(130, shown.length * 58 + 20), mid = H / 2;
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
  const svg = el('svg', { viewBox: `0 0 380 ${H}`, width: '100%', role: 'img', 'aria-label': t('vss.mapLabel', { title: link.title }) });
  const defs = el('defs', {});
  for (const [id, col] of [['vsa-in', 'var(--av-success)'], ['vsa-out', 'var(--av-accent)']]) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    m.append(el('path', { d: 'M2 1L8 5L2 9', fill: 'none', stroke: col, 'stroke-width': '1.6' }));
    defs.append(m);
  }
  svg.append(defs);
  svg.append(el('rect', { x: '4', y: String(mid - 24), width: '84', height: '48', rx: '8', class: 'vw-node-me' }));
  svg.append(el('text', { x: '46', y: String(mid - 6), 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'vw-node-t' }, t('me.subj')));
  svg.append(el('text', { x: '46', y: String(mid + 11), 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'vw-node-n' }, (node(me)?.name || '').slice(0, 14)));
  shown.forEach((key, i) => {
    const y = 10 + i * 58 + 24;
    const mine = flows.filter((f) => (f.source_node_id === me ? f.target_node_id : f.source_node_id) === (key === '__ext' ? null : key));
    const inF = mine.filter((f) => f.target_node_id === me), outF = mine.filter((f) => f.source_node_id === me);
    const draw = (fl, dir) => {
      if (!fl.length) return;
      const n = fl.reduce((s, f) => s + (count.get(f.id) || 0), 0);
      const [x1, y1, x2, y2] = dir === 'in' ? [246, y - 7, 92, mid - 7] : [92, mid + 7, 246, y + 7];
      svg.append(el('line', { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2), stroke: dir === 'in' ? 'var(--av-success)' : 'var(--av-accent)', 'stroke-width': '1.6', 'marker-end': `url(#${dir === 'in' ? 'vsa-in' : 'vsa-out'})`, ...(n ? {} : { 'stroke-dasharray': '4 4' }) }));
      const label = (fl.length === 1 ? (fl[0].name || '') : t('vss.nFlows', { n: fl.length })).slice(0, 16) + ' · ' + (n ? String(n) : t('vss.noEv'));
      svg.append(el('text', { x: '244', y: String(dir === 'in' ? y - 14 : y + 22), 'text-anchor': 'end', class: 'vw-node-n' }, label));
    };
    draw(inF, 'in'); draw(outF, 'out');
    const name = key === '__ext' ? t('vss.outside') : (node(key)?.name || key);
    const cid = key !== '__ext' ? link.nodeContacts?.[key] : null;
    const g = el('g', { class: 'vw-node', tabindex: '0', role: 'button' });
    g.append(el('rect', { x: '250', y: String(y - 18), width: '126', height: '36', rx: '7' }), el('text', { x: '313', y: String(y), 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'vw-node-t' }, name.slice(0, 18)));
    g.addEventListener('click', () => { if (cid && wallet.get(cid)) goLife({ t: 'p', cp: cid }); else toast(t('vss.noContact', { name })); });
    svg.append(g);
  });
  const rest = doc.flows.length - flows.length;
  return h('div', { class: 'vw-map' }, svg,
    h('p', { class: 'vw-muted vw-small' }, t('vss.mapHint')),
    sides.length > shown.length ? h('p', { class: 'vw-muted vw-small' }, t('vss.moreSides', { n: sides.length - shown.length })) : null,
    rest > 0 ? h('p', { class: 'vw-muted vw-small' }, t('vss.rest', { n: rest }), ' ', link.source !== 'file' ? h('a', { href: '/tools/vss/s/' + encodeURIComponent(schemaId) + '/', target: '_blank', rel: 'noopener' }, t('vss.openVss')) : null) : null,
    h('div', { class: 'vw-actions' },
      link.source !== 'file' ? h('button', { class: 'vw-btn vw-ghost', onclick: async () => { const d = await guard(() => fetchSchema(schemaId)); if (d) { await guard(() => wallet.linkSchema(sys.rootId, { ...link, doc: d.doc })); toast(t('vss.updated')); render(); } } }, t('vss.refresh')) : null,
      h('button', { class: 'vw-btn vw-ghost', onclick: async () => { if (confirm(t('vss.unlinkQ'))) { await guard(() => wallet.unlinkSchema(sys.rootId, schemaId)); lifeMap = false; render(); } } }, t('vss.unlink'))));
}

// A schema from the holder's ÆVRI account (same site, signed in) or from a share link of it
async function fetchSchema(id) {
  const r = await fetch('/api/v1/vss/schemas/' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error(t('vss.signIn')), { code: r.status });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const v = await r.json();
  return { doc: v.doc, title: v.title || v.doc?.schema?.name || id };
}

function linkSchemaDialog(sphereId) {
  return modal(t('vss.linkTitle', { sphere: sysTitle(sphereId) }), (close) => {
    const box = h('div', {});
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    const chooseNode = (schemaId, title, doc, source) => {
      const nodes = doc.nodes || [];
      const meSel = select(nodes.map((n) => [n.id, n.name || n.id]), nodes[0]?.id || '');
      const cts = contacts().filter((c) => c.body.type !== 'self');
      const auto = (n) => cts.find((c) => c.body.name.trim().toLowerCase() === String(n.name || '').trim().toLowerCase())?.rootId || '';
      const rows = nodes.map((n) => [n, select([['', t('vss.noMatch')], ...cts.map((c) => [c.rootId, c.body.name])], auto(n))]);
      fill(box, h('p', {}, t('vss.whoAmI', { title })), field(t('vss.meNode'), meSel),
        h('details', {}, h('summary', { class: 'vw-link' }, t('vss.matchSides')), rows.map(([n, s]) => field(n.name || n.id, s))),
        msg, h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', onclick: async () => {
          const nodeContacts = {};
          for (const [n, s] of rows) if (s.value && n.id !== meSel.value) nodeContacts[n.id] = s.value;
          try { await wallet.linkSchema(sphereId, { schemaId, title, doc, holderNodeId: meSel.value, nodeContacts, source }); lifeMap = 'vss:' + schemaId; close(true); render(); }
          catch (e) { msg.textContent = t('rl.failed', { msg: e.message }); }
        } }, t('vss.save'))));
    };
    const start = async () => {
      const linkIn = h('input', { type: 'url', placeholder: 'https://aeilus.institute/tools/vss/s/...' });
      const mine = h('div', { class: 'vw-list' }, h('p', { class: 'vw-muted' }, t('vss.loading')));
      fill(box, h('p', { class: 'vw-hint' }, t('vss.lead')), h('h3', {}, t('vss.mine')), mine,
        h('h3', {}, t('vss.byLink')), h('form', { class: 'vw-inline', onsubmit: async (e) => {
          e.preventDefault();
          const m = String(linkIn.value).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          if (!m) { msg.textContent = t('vss.badLink'); return; }
          try { const d = await fetchSchema(m[1]); chooseNode(m[1], d.title, d.doc, 'link'); } catch (err) { msg.textContent = err.message; }
        } }, linkIn, h('button', { class: 'vw-btn', type: 'submit' }, t('vss.open'))),
        h('button', { class: 'vw-btn vw-ghost', onclick: async () => {
          const d = await pickFile();
          if (!d) return;
          const doc = d.format === 'aevri.vss' || (Array.isArray(d.nodes) && Array.isArray(d.flows)) ? d : null;
          if (!doc) { msg.textContent = t('vss.notVss'); return; }
          chooseNode('file-' + (await C.hashJson(doc)).slice(7, 19), doc.schema?.name || t('vss.fromFile'), doc, 'file');
        } }, t('vss.file')), msg);
      if (location.origin !== 'https://aeilus.institute') { fill(mine, h('p', { class: 'vw-muted' }, t('vss.onlySite'))); return; }
      try {
        const r = await fetch('/api/v1/vss/schemas', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (r.status === 401 || r.status === 403) { fill(mine, h('p', { class: 'vw-muted' }, t('vss.signIn') + ' '), h('a', { href: '/auth/?backurl=' + encodeURIComponent('/tools/vledger/') }, t('ai.signInLink'))); return; }
        const items = (await r.json()).items || [];
        fill(mine, items.length ? items.map((it) => h('button', { class: 'vw-lrow', onclick: async () => { try { const d = await fetchSchema(it.id); chooseNode(it.id, it.title || d.title, d.doc, 'account'); } catch (e) { msg.textContent = e.message; } } },
          h('span', { class: 'vw-lmain' }, it.title || it.id), h('span', { class: 'vw-chev' }, '›'))) : h('p', { class: 'vw-muted' }, t('vss.noneMine')));
      } catch (e) { fill(mine, h('p', { class: 'vw-muted' }, e.message)); }
    };
    start();
    return box;
  });
}

// ---- timeline ----

function tabTimeline() {
  const sel = (key, opts) => {
    const s = select([['', t('f.all.' + key)], ...opts], filters[key]);
    s.setAttribute('aria-label', t('f.' + key));
    s.addEventListener('change', () => { filters[key] = s.value; render(); });
    return s;
  };
  let evs = events().sort((a, b) => String(b.body.occurredAt).localeCompare(String(a.body.occurredAt)));
  if (filters.system) evs = evs.filter((e) => (e.body.systemId || '') === filters.system);
  // Direction of value (owner, 2026-10-17): I gave it (I acted) or I received it (it was done to me, I use it, I saw it)
  if (filters.role) evs = evs.filter((e) => (e.body.role === 'actor') === (filters.role === 'gave'));
  if (filters.contact) evs = evs.filter((e) => involves(e, wallet.get(filters.contact) || { rootId: filters.contact, body: {} }));
  const as = assessments();
  if (filters.assessed) {
    const done = new Set(as.map((a) => a.body.eventId));
    evs = evs.filter((e) => done.has(e.rootId) === (filters.assessed === 'yes'));
  }
  const due = as.filter((a) => a.body.checkAfter && a.body.checkAfter <= today() && !as.some((b) => b.body.eventId === a.body.eventId && b.firstAt > a.firstAt));
  const out = [
    h('div', { class: 'vw-toolbar' },
      h('button', { class: 'vw-btn vw-primary', onclick: () => eventDialog() }, t('ev.add')),
      h('button', { class: 'vw-btn', onclick: registryDialog }, t('ev.fromRegistry')),
      h('button', { class: 'vw-btn', onclick: aevriImportDialog }, t('ai.btn'))),
    h('div', { class: 'vw-filters' },
      sel('system', systems().map((s) => [s.rootId, s.body.title])),
      sel('role', [['gave', t('dir.gave')], ['got', t('dir.got')]]),
      sel('assessed', [['yes', t('f.assessed.yes')], ['no', t('f.assessed.no')]]),
      sel('contact', contacts().filter((c) => c.body.type !== 'self').map((c) => [c.rootId, c.body.name]))),
  ];
  const assessedIds = new Set(as.map((a) => a.body.eventId));
  const open = events().filter((e) => !assessedIds.has(e.rootId));
  const calib = hasGoals() ? as.filter(needsCalibration) : [];
  if (open.length || calib.length) {
    out.push(h('div', { class: 'vw-card vw-notice vw-row' },
      open.length ? h('span', {}, t('q.left', { n: open.length })) : null,
      open.length ? h('button', { class: 'vw-btn vw-primary', onclick: () => queueDialog(open.map((e) => e.rootId)) }, t('q.go')) : null,
      calib.length ? h('span', {}, t('cal.left', { n: calib.length })) : null,
      calib.length ? h('button', { class: 'vw-btn', onclick: () => calibrate(calib) }, t('cal.go')) : null));
  }
  if (due.length) {
    out.push(h('div', { class: 'vw-card vw-due' }, h('strong', {}, t('ev.due')),
      due.map((a) => h('div', { class: 'vw-row' }, h('span', {}, phrase(wallet.get(a.body.eventId) || { body: {} })),
        h('button', { class: 'vw-btn', onclick: () => assessDialog(a.body.eventId, null, { phase: 'retro' }) }, t('ev.compare'))))));
  }
  if (!evs.length) out.push(h('p', { class: 'vw-empty' }, t('ev.empty')));
  let lastDay = '';
  for (const ev of evs) {
    const day = String(ev.body.occurredAt).slice(0, 10);
    if (day !== lastDay) { out.push(h('h3', { class: 'vw-day' }, day)); lastDay = day; }
    out.push(eventCard(ev, as));
  }
  return out;
}

function eventCard(ev, as) {
  const b = ev.body;
  const mine = as.filter((a) => a.body.eventId === ev.rootId).sort((x, y) => x.firstAt.localeCompare(y.firstAt));
  const plans = wallet.list('plan').filter((p) => p.body.eventId === ev.rootId);
  const s = wallet.settings();
  const realized = mine.filter((a) => a.body.phase === 'realized').pop();
  const retro = mine.filter((a) => a.body.phase === 'retro').pop();
  const latest = retro || realized;
  const eff = latest && latest.body.spentV > 0 ? latest.body.v / latest.body.spentV : null;
  const target = shareTarget(ev);
  const item = registryItem(ev);
  return h('article', { class: 'vw-card' },
    h('div', { class: 'vw-row' }, h('h3', {}, phrase(ev)),
      h('span', { class: 'vw-chips' }, h('span', { class: 'vw-chip' }, t('role.' + b.role)), b.systemId ? h('span', { class: 'vw-chip vw-chip-sys' }, sysTitle(b.systemId)) : null,
        b.registryRef ? h('span', { class: 'vw-chip' }, t('ev.fromReg')) : null,
        b.receiptState ? h('span', { class: 'vw-chip' + (b.receiptState === 'matched' ? ' vw-chip-sys' : '') }, t('rc.state.' + b.receiptState) + ((b.stamps || []).length ? ' · ' + t('rc.stamped') : '')) : null)),
    // One click is a whole assessment (owner, 2026-10-17); details, goals and phases only when there is something
    item && ((item.plan?.promise && !plans.length) || item.url) ? h('p', { class: 'vw-muted vw-small' }, item.plan?.promise && !plans.length ? t('reg.promise', { p: item.plan.promise }) + ' ' : '',
      item.url ? h('a', { href: item.url, target: '_blank', rel: 'noopener' }, t('ev.openItem')) : null) : null,
    reactionRow(ev.rootId, realized ? reactionOf(realized.body) : null),
    plans.length ? plans.map((p) => h('div', { class: 'vw-plan' }, `${t('phase.plan')}: ${p.body.author === selfId() ? t('plan.mine') : nameOf(p.body.author)}: ${p.body.promise}`,
      h('span', { class: 'vw-muted vw-small' }, ' · ' + t('plan.counted', { f: pct(V.planFactor(s, { contactId: p.body.author, systemId: b.systemId })) })))) : null,
    realized ? assessmentView(realized) : null,
    retro ? h('div', {}, h('div', { class: 'vw-muted vw-small' }, t('phase.retro')), assessmentView(retro)) : null,
    realized && hasGoals() && needsCalibration(realized) ? h('button', { class: 'vw-link', onclick: () => assessDialog(ev.rootId, realized) }, t('cal.one')) : null,
    (b.rulings || []).map((r) => h('p', { class: 'vw-ruling' }, h('span', { class: 'vw-chip' + (r.binding ? ' vw-chip-sys' : '') }, t(r.binding ? 'cs.binding' : 'cs.opinion')), ' ', t('cs.ruling', { decision: r.decision }))),
    (b.cases || []).some((c) => c.status === 'open') ? h('p', { class: 'vw-muted vw-small' }, t('cs.open')) : null,
    (b.cases || []).filter((c) => c.status === 'declined').map((c) => h('p', { class: 'vw-muted vw-small' }, t('cs.declined', { reason: c.reason || '-' }))),
    eff !== null ? h('p', { class: 'vw-muted vw-small' }, t('ev.efficiency', { e: num(eff), net: pct(latest.body.v - latest.body.spentV) })) : null,
    h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn vw-ghost', onclick: () => refineDialog(ev.rootId) }, t('rf.go')),
      latest && target ? h('button', { class: 'vw-btn', onclick: () => shareDialog(ev, latest, target) }, t('ev.share', { name: nameOf(target) })) : null,
      !b.receiptState && receiptTarget(ev) ? h('button', { class: 'vw-btn', onclick: () => confirmDialog(ev, receiptTarget(ev)) }, t('rc.btn')) : null,
      b.receiptState === 'matched' && !(b.stamps || []).length ? h('button', { class: 'vw-btn vw-ghost', onclick: async () => {
        const st = await guard(() => wallet.stampAt(ev.rootId, (wallet.settings().arbiters || [])[0]?.url || AEVRI_ARBITER));
        if (st) { toast(t('rc.stampDone', { at: st.receivedAt.replace('T', ' ').slice(0, 16) })); render(); }
      } }, t('rc.stamp')) : null,
      b.receipt && b.receiptState === 'matched' ? h('button', { class: 'vw-btn vw-ghost', onclick: () => caseDialog(ev) }, t('cs.ask')) : null,
      (b.cases || []).some((c) => c.status === 'open') ? h('button', { class: 'vw-btn vw-ghost', onclick: async () => {
        const done = await guard(() => wallet.refreshCases(ev.rootId));
        if (done) { toast(done.length ? t('cs.got') : t('cs.none')); render(); }
      } }, t('cs.check')) : null,
      h('details', { class: 'vw-more' }, h('summary', { class: 'vw-btn vw-ghost', 'aria-label': t('more') }, '⋯'),
        h('div', { class: 'vw-more-menu' },
          realized ? h('button', { class: 'vw-btn vw-ghost', onclick: () => assessDialog(ev.rootId, null, { phase: 'retro' }) }, t('ev.assessLater')) : null,
          h('button', { class: 'vw-btn vw-ghost', onclick: () => planDialog(ev.rootId) }, t('ev.plan')),
          h('button', { class: 'vw-btn vw-ghost', onclick: () => eventDialog(ev) }, t('edit')),
          itemMenu(ev)))));
}

// One event at a time: a reaction saves it and shows the next (owner, 2026-10-17)
function queueDialog(ids) {
  let i = 0, done = 0;
  return modal(t('q.title'), (close) => {
    const box = h('div', { class: 'vw-queue' });
    const show = () => {
      while (i < ids.length && !wallet.get(ids[i])) i++;
      if (i >= ids.length) { close(true); toast(t('q.done', { n: done })); render(); return; }
      const ev = wallet.get(ids[i]);
      const it = registryItem(ev);
      box.replaceChildren(...[
        h('p', { class: 'vw-muted vw-small' }, t('q.pos', { i: i + 1, n: ids.length }) + (ev.body.systemId ? ' · ' + sysTitle(ev.body.systemId) : '') + ' · ' + String(ev.body.occurredAt).slice(0, 10)),
        h('h3', {}, phrase(ev)),
        it?.plan?.promise ? h('p', { class: 'vw-muted' }, t('reg.promise', { p: it.plan.promise })) : null,
        it?.url ? h('p', {}, h('a', { href: it.url, target: '_blank', rel: 'noopener' }, t('ev.openItem'))) : null,
        h('p', { class: 'vw-label' }, t('rx.q')),
        reactionRow(ev.rootId, null, () => { done++; i++; show(); }),
        h('div', { class: 'vw-actions' },
          h('button', { class: 'vw-btn', onclick: () => { i++; show(); } }, t('q.skip')),
          h('button', { class: 'vw-btn vw-ghost', onclick: () => { close(true); render(); } }, t('q.stop')))].filter(Boolean));
    };
    show();
    return box;
  });
}

// When goals appear, reaction-only assessments are calibrated by them one by one
async function calibrate(list) {
  for (const a of list) {
    const cur = wallet.get(a.rootId);
    if (!cur) continue;
    const r = await assessDialog(cur.body.eventId, cur);
    if (!r) break;
  }
  render();
}

function assessmentView(a) {
  const b = a.body;
  const rx = reactionOf(b);
  return h('div', { class: 'vw-assess' },
    rx !== null && b.phase === 'retro' ? h('div', { class: 'vw-chip' + (rx < 0 ? ' vw-neg' : '') }, t('rx.' + rx)) : null,
    b.comparison && !(b.contributions || []).length ? h('div', { class: 'vw-muted vw-small' }, compareWords(b.comparison)) : null,
    typeof b.v === 'number' && (b.contributions || []).length ? h('div', { class: b.v < 0 ? 'vw-v vw-neg' : 'vw-v' }, t(b.v < 0 ? 'val.short.harm' : 'val.short', { v: pct(Math.abs(b.v)) })) : null,
    b.spentV > 0 ? h('div', { class: 'vw-muted vw-small' }, t('val.spentShort', { v: pct(b.spentV) })) : null,
    b.vet ? h('div', { class: 'vw-muted vw-small' }, t('vet.line', { out: num(b.vet.totals?.sumOut ?? 0), in: num(b.vet.totals?.sumIn ?? 0), n: b.vet.totals?.count ?? 0 })) : null,
    b.ownScore && rx === null ? h('div', { class: 'vw-muted vw-small' }, t('as.ownShow', { v: b.ownScore.value.toLocaleString(lang), u: b.ownScore.unit || '' })) : null,
    b.reference ? h('div', { class: 'vw-chip' }, t('as.isReference')) : null,
    (b.gained || []).map((x) => h('div', { class: 'vw-gained' }, '+ ' + x)),
    (b.lost || []).map((x) => h('div', { class: 'vw-lost' }, '- ' + x)),
    b.reasons ? h('div', { class: 'vw-muted vw-small' }, b.reasons) : null);
}

function itemMenu(item) {
  return h('span', { class: 'vw-menu' },
    item.versions > 1 ? h('button', { class: 'vw-btn vw-ghost', onclick: () => historyDialog(item.rootId) }, t('history', { n: item.versions })) : null,
    h('button', { class: 'vw-btn vw-ghost', onclick: async () => { if (confirm(t('withdraw.confirm'))) { await guard(() => wallet.withdraw(item.rootId)); render(); } } }, t('withdraw')),
    h('button', { class: 'vw-btn vw-ghost vw-danger', onclick: async () => { if (confirm(t('erase.confirm'))) { await guard(() => wallet.eraseItem(item.rootId)); toast(t('erase.done')); render(); } } }, t('erase')));
}

function historyDialog(rootId) {
  return modal(t('history.title'), () => h('ol', { class: 'vw-history' }, wallet.versions(rootId).map((v) =>
    h('li', {}, h('div', { class: 'vw-muted' }, v.payload ? v.payload.createdAt.replace('T', ' ').slice(0, 16) : t('erased')),
      v.payload ? h('pre', {}, JSON.stringify(v.payload.body, null, 1)) : null))));
}

function objectRows(list, types) {
  const wrap = h('div', { class: 'vw-elements' });
  const addRow = (el = {}) => {
    const row = h('div', { class: 'vw-element' },
      h('input', { type: 'text', class: 'el-label', maxlength: 300, placeholder: t('el.label'), value: el.label || '', 'aria-label': t('el.label') }),
      h('input', { type: 'number', class: 'el-q', step: 'any', placeholder: t('el.qty'), value: el.quantity ?? '', 'aria-label': t('el.qty') }),
      h('input', { type: 'text', class: 'el-u', maxlength: 40, placeholder: t('el.unit'), value: el.unit || '', 'aria-label': t('el.unit') }),
      select([['', t('el.noType')], ...types.map((x) => [x.rootId, x.body.name])], el.typeId || ''),
      h('button', { type: 'button', class: 'vw-icon', 'aria-label': t('remove'), onclick: () => row.remove() }, '×'));
    wrap.insertBefore(row, wrap.lastChild);
  };
  wrap.append(h('button', { type: 'button', class: 'vw-link', onclick: () => addRow() }, t('el.add')));
  list.forEach(addRow);
  return { node: wrap, add: addRow, read: () => [...wrap.querySelectorAll('.vw-element')].map((r) => {
    const label = r.querySelector('.el-label').value.trim();
    if (!label) return null;
    const o = { label };
    const q = r.querySelector('.el-q').value; if (q !== '') o.quantity = Number(q);
    const u = r.querySelector('.el-u').value.trim(); if (u) o.unit = u;
    const ty = r.querySelector('select').value; if (ty) o.typeId = ty;
    return o;
  }).filter(Boolean) };
}

function contactPicker(selected = [], { exclude = [] } = {}) {
  const box = h('div', { class: 'vw-picks' });
  for (const c of contacts().filter((x) => !exclude.includes(x.rootId))) {
    box.append(h('label', { class: 'vw-check vw-pick' }, h('input', { type: 'checkbox', value: c.rootId, checked: selected.includes(c.rootId) }), h('span', {}, c.body.type === 'self' ? t('me.obj') : c.body.name)));
  }
  return { node: box, read: () => [...box.querySelectorAll('input:checked')].map((x) => x.value) };
}

function eventDialog(ev, preset = {}) {
  const me = selfId();
  const b = ev ? ev.body : { role: 'affected', actor: '', action: '', objects: [], affected: [me], occurredAt: today(), status: 'confirmed', ...preset };
  return modal(t(ev ? 'ev.editTitle' : 'ev.addTitle'), (close) => {
    const pastActions = [...new Set(events(true).map((e) => e.body.action))].slice(0, 50);
    const dl = h('datalist', { id: 'vw-actions' }, pastActions.map((a) => h('option', { value: a })));
    const roleBox = h('div', { class: 'vw-roles', role: 'radiogroup', 'aria-label': t('ev.role') },
      ['actor', 'affected', 'user', 'witness'].map((r) => h('label', { class: 'vw-radio' }, h('input', { type: 'radio', name: 'role', value: r, checked: b.role === r }), h('span', {}, t('roleQ.' + r)))));
    const others = contacts().filter((c) => c.rootId !== me);
    const actor = select([[me, t('me.subj')], ...others.map((c) => [c.rootId, c.body.name]), ['__new', t('cp.new')]], b.actor || (others[0]?.rootId ?? '__new'));
    const newType = select(['person', 'organization', 'state', 'group', 'device', 'unknown'].map((k) => [k, t('cpt.' + k)]), 'person');
    const newName = h('input', { type: 'text', maxlength: 300, placeholder: t('cp.name') });
    const newBox = h('div', { class: 'vw-inline', hidden: actor.value !== '__new' }, newType, newName);
    actor.addEventListener('change', () => { newBox.hidden = actor.value !== '__new'; });
    const action = h('input', { type: 'text', maxlength: 300, list: 'vw-actions', value: b.action, placeholder: t('ev.actionPh') });
    const objs = objectRows(b.objects || [], wallet.list('element-type'));
    if (!ev && !(b.objects || []).length) objs.add();
    const aff = contactPicker(b.affected || []);
    const sys = select([['', t('sys.none')], ...systems().filter((s) => s.body.status === 'active').map((s) => [s.rootId, s.body.title])], b.systemId || '');
    const date = h('input', { type: 'date', value: String(b.occurredAt).slice(0, 10) });
    const approx = h('input', { type: 'checkbox', checked: !!b.approx });
    const syncRole = () => {
      const role = roleBox.querySelector('input:checked').value;
      if (role === 'actor' || role === 'user') { actor.value = me; actor.disabled = true; } else actor.disabled = false;
      newBox.hidden = actor.value !== '__new';
      const meBox = aff.node.querySelector(`input[value="${me}"]`);
      if (meBox) meBox.checked = role === 'affected' ? true : (role === 'actor' || role === 'user' ? false : meBox.checked);
    };
    roleBox.addEventListener('change', syncRole);
    actor.addEventListener('change', () => {
      const last = events(true).filter((e) => e.body.actor === actor.value && e.body.systemId).pop();
      if (last && !sys.value) sys.value = last.body.systemId;
    });
    setTimeout(syncRole, 0);
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const role = roleBox.querySelector('input:checked').value;
      if (!action.value.trim()) { msg.textContent = t('ev.needAction'); return; }
      let actorId = actor.value;
      if (actorId === '__new') {
        if (!newName.value.trim()) { msg.textContent = t('cp.needName'); return; }
        actorId = await wallet.add('contact', { type: newType.value, name: newName.value.trim() });
      }
      const body = { actor: actorId, action: action.value.trim(), objects: objs.read(), affected: aff.read(), role, occurredAt: date.value || today(), status: 'confirmed', stamps: b.stamps || [], rulings: b.rulings || [] };
      if (b.actionType) body.actionType = b.actionType;
      if (sys.value) body.systemId = sys.value;
      if (approx.checked) body.approx = true;
      if (b.registryRef) body.registryRef = b.registryRef;
      if (b.vssRef) body.vssRef = b.vssRef;
      const id = await guard(() => (ev ? wallet.correct(ev.rootId, body) : wallet.add('event', body, b.registryRef ? { source: 'registry' } : {})));
      close(id); render();
    } },
    dl, h('fieldset', {}, h('legend', {}, t('ev.role')), roleBox),
    h('div', { class: 'vw-sentence' },
      field(t('ev.who'), actor), newBox,
      field(t('ev.did'), action, t('ev.didHint')),
      h('fieldset', {}, h('legend', {}, t('ev.what')), objs.node),
      h('fieldset', {}, h('legend', {}, t('ev.whom')), aff.node)),
    h('div', { class: 'vw-inline' }, field(t('ev.system'), sys), field(t('ev.when'), date), h('label', { class: 'vw-check' }, approx, h('span', {}, t('ev.approx')))),
    msg, submitRow());
  });
}

// ---- registry ----

function registryDialog() {
  return modal(t('reg.open'), (close) => {
    const url = h('input', { type: 'url', value: AEVRI_REGISTRY, required: true });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = t('create.wait');
      try { const doc = await fetchRegistry(url.value.trim()); close(true); await showRegistry(doc, 'url'); } catch (err) { msg.textContent = t('rl.failed', { msg: err.message }); }
    } }, h('p', { class: 'vw-hint' }, t('reg.openHint')), field(t('reg.url'), url), msg,
      h('div', { class: 'vw-actions' },
        h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('reg.openGo')),
        h('button', { class: 'vw-btn', type: 'button', onclick: async () => { const doc = await pickFile(); if (doc) { close(true); await showRegistry(doc, 'file'); } } }, t('reg.fromFile'))));
  });
}

async function showRegistry(doc, origin, itemId = '') {
  const reg = doc?.registry;
  if (!reg || reg.type !== 'aevri.vledger.registry') { toast(t('reg.bad')); return; }
  const ok = await C.verify(C.keyOfAddress(reg.owner.card.address), C.te.encode(C.canon(reg)), doc.sig) && await C.verifyCard(reg.owner);
  if (!ok) { toast(t('reg.badSig')); return; }
  const one = reg.items.filter((it) => it.itemId === itemId);
  let host = '';
  try { host = new URL(reg.registryUrl).host; } catch { /* a file without a valid address */ }
  await modal(t('reg.title', { name: reg.owner.card.name || short(reg.owner.card.address) }), (close) => h('div', {},
    h('p', { class: 'vw-hint' }, t('reg.hint')),
    host ? h('p', { class: 'vw-muted vw-small' }, t('reg.source', { host })) : null,
    (one.length ? one : reg.items).map((it) => h('div', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('strong', {}, it.title), h('span', { class: 'vw-chip' }, t('reg.kind.' + it.kind))),
      it.plan ? h('p', { class: 'vw-plan' }, t('reg.promise', { p: it.plan.promise })) : null,
      it.affects ? h('p', { class: 'vw-muted' }, it.affects) : null,
      h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', onclick: async () => { close(true); await addFromRegistry(doc, it, origin); } }, t(it.kind === 'object' ? 'reg.use' : 'reg.affected')))))));
}

async function addFromRegistry(doc, it, origin = 'file') {
  const reg = doc.registry;
  const owner = await guard(() => wallet.addCard(reg.owner));
  if (!owner) return;
  // keep the newest copy of the registry: its public references (medians of 5 and more) change over time
  const imp = wallet.list('import').find((i) => i.body.originId === reg.registryUrl);
  if (!imp) await wallet.add('import', { origin, originId: reg.registryUrl, payload: doc, payloadHash: await C.hashJson(doc) }, { source: 'registry' });
  else if ((imp.body.payload?.registry?.updatedAt || '') < (reg.updatedAt || '')) await wallet.correct(imp.rootId, { ...imp.body, payload: doc, payloadHash: await C.hashJson(doc) });
  const sysId = await wallet.registrySystem(reg, it.system);
  const ref = { registryUrl: reg.registryUrl, itemId: it.itemId, owner: reg.owner.card.address };
  const me = selfId();
  const preset = it.kind === 'object'
    ? { role: 'user', actor: me, action: (it.actions || [])[0] || t('reg.defaultAction'), objects: [{ label: it.title }], affected: [], systemId: sysId, registryRef: ref }
    : { role: 'affected', actor: owner, action: it.title, actionType: 'registry-event', objects: [], affected: [me], systemId: sysId, registryRef: ref, occurredAt: it.occurredAt || today() };
  const evId = await eventDialog(null, preset);
  if (evId && it.plan) {
    await wallet.add('plan', { eventId: evId, ...(it.kind === 'object' ? { objectIndex: 0 } : {}), author: owner, promise: it.plan.promise, ...(typeof it.plan.plannedV === 'number' ? { plannedV: it.plan.plannedV } : {}), registryRef: ref }, { source: 'registry' });
    render();
  }
}

// All materials of the institute registry on the timeline, with the holder's own reactions from the site (2026-10-17).
function aevriImportDialog() {
  const onSite = location.origin === 'https://aeilus.institute';
  return modal(t('ai.title'), (close) => {
    const mine = h('input', { type: 'checkbox', checked: onSite, disabled: !onSite });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = t('create.wait');
      try {
        const doc = await fetchRegistry(AEVRI_REGISTRY);
        const reg = doc.registry;
        if (!(await C.verify(C.keyOfAddress(reg.owner.card.address), C.te.encode(C.canon(reg)), doc.sig)) || !(await C.verifyCard(reg.owner))) throw new Error(t('reg.badSig'));
        let evals = [];
        if (mine.checked) {
          const r = await fetch('/api/v1/vledger/me/evaluations', { credentials: 'same-origin', cache: 'no-store' });
          if (r.status === 401) {
            msg.replaceChildren(t('ai.signIn') + ' ', h('a', { href: '/auth/?backurl=' + encodeURIComponent('/tools/vledger/') }, t('ai.signInLink')));
            return;
          }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          if (j.registryUrl !== reg.registryUrl) throw new Error('registry mismatch');
          evals = j.items || [];
        }
        const n = await wallet.importRegistryItems(doc, evals, { unit: t('ai.unit') });
        close(true); render();
        toast(t('ai.done', { events: n.events, assessments: n.assessments }));
      } catch (err) { msg.textContent = t('rl.failed', { msg: err.message }); }
    } }, h('p', {}, t('ai.lead')),
      h('label', { class: 'vw-check' }, mine, h('span', {}, t('ai.mine'))),
      h('p', { class: 'vw-hint' }, onSite ? t('ai.privacy') : t('ai.offSite')), msg, submitRow(t('ai.go')));
  });
}

// replaceChildren prints null and arrays as text; keep only real nodes
const fill = (box, ...items) => box.replaceChildren(...items.flat(Infinity).filter((x) => x != null && x !== false));

// ---- refine: one assessment, refined by comparison or by goals (SPEC 17, UX review round 3) ----

function compareWords(c) {
  if (c.ratio == null) return t('cmp.hardSaved', { ref: c.referenceTitle || '' });
  const words = t('cmp.r' + String(c.ratio).replace('.', '_') + (c.polarity === 'harm' ? 'h' : ''), { ref: c.referenceTitle || '' });
  return typeof c.estV === 'number' ? words + ' · ' + t('cmp.est', { v: pct(Math.abs(c.estV)) }) : words;
}

function refineDialog(evRootId) {
  const ev = wallet.get(evRootId);
  if (!ev) return null;
  const realized = assessments().filter((a) => a.body.eventId === evRootId && a.body.phase === 'realized').pop();
  const rx = realized ? reactionOf(realized.body) : null;
  return modal(t('rf.title'), (close) => h('div', {},
    h('p', { class: 'vw-muted' }, phrase(ev)),
    rx !== null ? h('p', {}, t('rf.saved', { r: t('rx.' + rx) })) : h('p', { class: 'vw-hint' }, t('rf.noReaction')),
    h('div', { class: 'vw-list' },
      h('button', { class: 'vw-lrow', onclick: () => { close(true); compareDialog(evRootId); } }, h('span', { class: 'vw-lmain' }, t('rf.compare'), h('small', {}, t('rf.compareHint'))), h('span', { class: 'vw-chev' }, '›')),
      h('button', { class: 'vw-lrow', onclick: () => { close(true); goalsDialog(evRootId); } }, h('span', { class: 'vw-lmain' }, t('rf.goals'), h('small', {}, hasGoals() ? t('rf.goalsHint') : t('rf.goalsNone'))), h('span', { class: 'vw-chev' }, '›')),
      h('button', { class: 'vw-lrow', onclick: () => { close(true); assessDialog(evRootId, realized || null, { phase: 'realized' }); } }, h('span', { class: 'vw-lmain' }, t('rf.cost'), h('small', {}, t('rf.costHint'))), h('span', { class: 'vw-chev' }, '›')))));
}

// Candidate references: same sphere first, same polarity, a goal value preferred, marked references first
function referenceCandidates(ev, polarity) {
  const latest = new Map();
  for (const a of assessments()) if (a.body.eventId !== ev.rootId) latest.set(a.body.eventId, a.body);
  const out = [];
  for (const [eid, b] of latest) {
    const e = wallet.get(eid);
    if (!e) continue;
    const rx = reactionOf(b);
    const pos = (typeof b.v === 'number' && (b.contributions || []).length) ? b.v > 0 : rx !== null ? rx >= 20 : null;
    const neg = (typeof b.v === 'number' && (b.contributions || []).length) ? b.v < 0 : rx !== null ? rx < 0 : null;
    if (polarity === 'benefit' ? pos !== true : neg !== true) continue;
    const goalV = (b.contributions || []).length && typeof b.v === 'number' ? b.v : null;
    const score = (e.body.systemId === ev.body.systemId ? 4 : 0) + (b.reference ? 2 : 0) + (goalV !== null ? 1 : 0);
    out.push({ eid, title: phrase(e), refV: goalV, score, at: String(e.body.occurredAt) });
  }
  return out.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
}

function compareDialog(evRootId) {
  const ev = wallet.get(evRootId);
  return modal(t('cmp.title'), (close) => {
    const box = h('div', {});
    let polarity = null, idx = 0, cands = [];
    const step1 = () => fill(box, h('p', { class: 'vw-muted' }, phrase(ev)), h('p', { class: 'vw-label' }, t('cmp.q')),
      h('div', { class: 'vw-reacts' },
        h('button', { type: 'button', class: 'vw-react', onclick: () => { polarity = 'benefit'; step2(); } }, t('cmp.benefit')),
        h('button', { type: 'button', class: 'vw-react is-neg', onclick: () => { polarity = 'harm'; step2(); } }, t('cmp.harm')),
        h('button', { type: 'button', class: 'vw-react', onclick: () => fill(box, h('p', {}, t('cmp.unclear')), h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn', onclick: () => close(true) }, t('close')))) }, t('cmp.unclearBtn'))));
    const step2 = () => {
      cands = referenceCandidates(ev, polarity);
      if (!cands.length) {
        fill(box, h('p', {}, t(polarity === 'harm' ? 'cmp.noneHarm' : 'cmp.none')),
          h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', onclick: () => { close(true); goalsDialog(evRootId); } }, t('rf.goals')), h('button', { class: 'vw-btn', onclick: () => close(true) }, t('close'))));
        return;
      }
      const c = cands[idx % cands.length];
      const save = async (ratio) => {
        const comparison = { referenceEventId: c.eid, referenceTitle: c.title.slice(0, 300), polarity, ratio, at: C.nowIso() };
        if (c.refV !== null) comparison.refV = c.refV;
        const est = V.comparisonEstimate(c.refV, ratio, polarity);
        if (est !== null) comparison.estV = est;
        await guard(() => wallet.refine(evRootId, { comparison }));
        close(true); render(); toast(compareWords(comparison));
      };
      fill(box, h('p', { class: 'vw-muted' }, phrase(ev)),
        h('p', { class: 'vw-label' }, t(polarity === 'harm' ? 'cmp.vsHarm' : 'cmp.vs')),
        h('div', { class: 'vw-card' }, h('strong', {}, c.title), h('div', { class: 'vw-muted vw-small' }, c.at.slice(0, 10) + (c.refV !== null ? ' · ' + t('cmp.refGoal', { v: pct(Math.abs(c.refV)) }) : ' · ' + t('cmp.refRel')))),
        h('div', { class: 'vw-reacts' }, [0.5, 1, 2].map((r) => h('button', { type: 'button', class: 'vw-react', onclick: () => save(r) }, t('cmp.b' + String(r).replace('.', '_')))),
          h('button', { type: 'button', class: 'vw-react', onclick: () => save(null) }, t('cmp.bHard'))),
        cands.length > 1 ? h('button', { class: 'vw-link', onclick: () => { idx++; step2(); } }, t('cmp.other', { n: cands.length })) : null,
        h('p', { class: 'vw-hint' }, t('cmp.hint')));
    };
    step1();
    return box;
  });
}

// By goals in two taps: a goal of the sphere, then an amount in the goal's units or about 1, 5, 10 % of it
function goalsDialog(evRootId) {
  const ev = wallet.get(evRootId);
  const realized = assessments().filter((a) => a.body.eventId === evRootId && a.body.phase === 'realized').pop();
  const all = wallet.list('goal').filter((g) => g.body.status === 'active');
  const near = all.filter((g) => g.body.systemId && g.body.systemId === ev.body.systemId);
  return modal(t('gq.title'), (close) => {
    const box = h('div', {});
    const pickGoal = () => {
      if (!all.length) {
        fill(box, h('p', {}, t('gq.none')), h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', onclick: () => { close(true); goalDialog(); } }, t('life.addGoal'))));
        return;
      }
      const shown = (near.length ? near : all).slice(0, 3);
      const others = all.filter((g) => !shown.includes(g));
      const other = others.length ? select([['', t('gq.other')], ...others.map((g) => [g.rootId, (g.body.systemId ? sysTitle(g.body.systemId) + ' · ' : '') + g.body.title])], '') : null;
      if (other) other.addEventListener('change', () => { const g = all.find((x) => x.rootId === other.value); if (g) pickAmount(g); });
      fill(box, h('p', { class: 'vw-muted' }, phrase(ev)), h('p', { class: 'vw-label' }, t('gq.q')),
        h('div', { class: 'vw-list' }, shown.map((g) => h('button', { class: 'vw-lrow', onclick: () => pickAmount(g) }, h('span', { class: 'vw-lmain' }, g.body.title, h('small', {}, sysTitle(g.body.systemId))), h('span', { class: 'vw-chev' }, '›')))),
        other ? field(t('gq.otherLabel'), other) : null);
    };
    const pickAmount = (g) => {
      const save = async (c) => {
        const prev = (realized?.body.contributions || []).filter((x) => x.goalId !== g.rootId);
        const contributions = [...prev, { goalId: g.rootId, ...c }];
        const r = valueOf(contributions, realized?.body.spent || []);
        const fields = { contributions, v: r.v };
        if ((realized?.body.spent || []).length) fields.spentV = r.spentV;
        await guard(() => wallet.refine(evRootId, fields));
        close(true); render(); toast(t('gq.saved', { v: pct(Math.abs(r.v)) }));
      };
      const unit = g.body.unit && g.body.N ? g.body.unit : null;
      const opts = unit
        ? [1, 2, 5].map((n) => [t('gq.units', { n, unit, of: g.body.N }), { c: n }])
        : [[t('gq.pct', { p: 1 }), { k: 0.01 }], [t('gq.pct', { p: 5 }), { k: 0.05 }], [t('gq.pct', { p: 10 }), { k: 0.1 }]];
      const custom = h('input', { type: 'number', step: 'any', placeholder: unit ? t('gq.inUnits', { unit }) : t('gq.inPct') });
      fill(box, h('p', { class: 'vw-muted' }, g.body.title), h('p', { class: 'vw-label' }, t('gq.how')),
        h('div', { class: 'vw-reacts' }, opts.map(([label, c]) => h('button', { type: 'button', class: 'vw-react', onclick: () => save(c) }, label)),
          h('button', { type: 'button', class: 'vw-react is-neg', onclick: () => save(unit ? { c: -1 } : { k: -0.05 }) }, t('gq.back'))),
        h('form', { class: 'vw-inline', onsubmit: (e) => { e.preventDefault(); const n = Number(custom.value); if (!Number.isFinite(n) || custom.value === '') return; save(unit ? { c: n } : { k: n / 100 }); } },
          field(t('gq.custom'), custom), h('button', { class: 'vw-btn', type: 'submit' }, t('save'))),
        h('p', { class: 'vw-hint' }, t('gq.hint')),
        h('button', { class: 'vw-link', onclick: pickGoal }, '‹ ' + t('gq.back2')));
    };
    pickGoal();
    return box;
  });
}

// ---- plan ----

function planDialog(evRootId, plan) {
  const ev = wallet.get(evRootId);
  const p = plan ? plan.body : {};
  return modal(t('plan.title'), (close) => {
    const me = selfId();
    const author = select(contacts().map((c) => [c.rootId, c.rootId === me ? t('plan.mineLong') : c.body.name]), p.author || (ev.body.actor !== me ? ev.body.actor : me));
    const promise = h('textarea', { rows: 3, maxlength: 2000 }, p.promise || '');
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!promise.value.trim()) { msg.textContent = t('plan.need'); return; }
      const body = { eventId: evRootId, author: author.value, promise: promise.value.trim() };
      await guard(() => (plan ? wallet.correct(plan.rootId, body) : wallet.add('plan', body)));
      close(true); render();
    } }, h('p', { class: 'vw-hint' }, t('plan.hint')), field(t('plan.author'), author), field(t('plan.promise'), promise), msg, submitRow());
  });
}

// ---- assessment ----

function goalOptions() {
  const sys = Object.fromEntries(systems().map((s) => [s.rootId, s.body.title]));
  return wallet.list('goal').filter((g) => g.body.status === 'active').map((g) => [g.rootId, (g.body.systemId && sys[g.body.systemId] ? sys[g.body.systemId] + ' · ' : '') + g.body.title]);
}

function contribRows(list, onChange, defaultGoal) {
  const box = h('div', { class: 'vw-contribs' });
  const opts = goalOptions();
  const add = (c = {}) => {
    const g = select(opts, c.goalId || defaultGoal);
    const mode = select([['pct', t('as.inPct')], ['amount', t('as.inUnits')]], 'c' in c ? 'amount' : 'pct');
    mode.classList.add('c-mode');
    const amt = h('input', { type: 'number', step: 'any', value: 'c' in c ? c.c : (c.k != null ? c.k * 100 : ''), 'aria-label': t('as.amount') });
    const row = h('div', { class: 'vw-contrib' }, g, amt, mode, h('button', { type: 'button', class: 'vw-icon', 'aria-label': t('remove'), onclick: () => { row.remove(); onChange(); } }, '×'));
    [g, amt, mode].forEach((x) => x.addEventListener('input', onChange));
    box.append(row);
  };
  list.forEach(add);
  return { node: box, add, read: () => [...box.querySelectorAll('.vw-contrib')].map((r) => {
    const goalId = r.querySelector('select').value, amount = r.querySelector('input').value, m = r.querySelector('.c-mode').value;
    if (!goalId || amount === '') return null;
    return m === 'pct' ? { goalId, k: Number(amount) / 100 } : { goalId, c: Number(amount) };
  }).filter(Boolean) };
}

function orientation(systemId, eventId) {
  const refs = referencesFor(systemId, eventId);
  const w = V.goalWeights(goalsForValue(), systemsForValue());
  const goals = wallet.list('goal').filter((g) => g.body.status === 'active' && (systemId ? g.body.systemId === systemId : true));
  return h('aside', { class: 'vw-orient' },
    h('h3', {}, t('or.title', { sys: sysTitle(systemId) })),
    h('div', { class: 'vw-label' }, t('or.refs')),
    refs.length ? h('ul', {}, refs.map((r) => h('li', {}, `${r.phrase}: ${t('val.short', { v: pct(r.v) })}`, r.public ? h('span', { class: 'vw-muted' }, ' · ' + t('or.public')) : null))) : h('p', { class: 'vw-muted' }, t('or.noRefs')),
    h('div', { class: 'vw-label' }, t('or.goals')),
    goals.length ? h('ul', {}, goals.map((g) => h('li', {}, `${g.body.title}: ${t('or.goalLine', { w: pct(w[g.rootId] || 0), k: pct(goalProgress(g.rootId)) })}`))) : h('p', { class: 'vw-muted' }, t('or.noGoals')));
}

function assessDialog(evRootId, existing, preset = {}) {
  const ev = wallet.get(evRootId);
  if (!ev) return null;
  const all = assessments().map((a) => a.body);
  const canRetro = V.retroAllowed(all, evRootId, null) || V.retroAllowed(all, evRootId, 0);
  const b = existing ? existing.body : { phase: preset.phase && (preset.phase !== 'retro' || canRetro) ? preset.phase : 'realized', confidence: 'medium', contributions: [], spent: [], reference: false };
  const hasPlan = wallet.list('plan').some((p) => p.body.eventId === evRootId);
  const sysGoal = wallet.list('goal').find((g) => g.body.status === 'active' && g.body.systemId === ev.body.systemId)?.rootId;
  return modal(t('as.title', { ev: phrase(ev) }), (close) => {
    const phaseOpts = [['realized', t('phase.realized')]];
    if (canRetro || b.phase === 'retro') phaseOpts.push(['retro', t('phase.retro')]);
    const phaseSel = select(phaseOpts, b.phase);
    let rx = reactionOf(b);
    const rxBox = h('div', { class: 'vw-reacts' }, REACTIONS.map((v) => {
      const btn = h('button', { type: 'button', class: 'vw-react' + (v === rx ? ' is-on' : '') + (v < 0 ? ' is-neg' : '') }, t('rx.' + v));
      btn.addEventListener('click', () => { rx = rx === v ? null : v; rxBox.querySelectorAll('.vw-react').forEach((x, i) => x.classList.toggle('is-on', REACTIONS[i] === rx)); });
      return btn;
    }));
    const gained = h('textarea', { rows: 2, placeholder: t('as.linesPh') }, (b.gained || []).join('\n'));
    const lost = h('textarea', { rows: 2, placeholder: t('as.linesPh') }, (b.lost || []).join('\n'));
    const preview = h('p', { class: 'vw-preview', 'aria-live': 'polite' });
    const refresh = () => {
      const r = valueOf(contribs.read(), spent.read());
      preview.textContent = valueWords(r, ev.body.systemId, evRootId);
    };
    const contribs = contribRows(b.contributions || [], refresh, sysGoal);
    const spent = contribRows(b.spent || [], refresh, undefined);
    if (!(b.contributions || []).length && goalOptions().length) contribs.add(sysGoal ? { goalId: sysGoal } : undefined);
    const own = h('input', { type: 'number', step: 'any', value: b.ownScore?.value ?? '' });
    const ownU = h('input', { type: 'text', maxlength: 40, placeholder: t('as.unitPh'), value: b.ownScore?.unit || '' });
    const conf = select(['low', 'medium', 'high'].map((k) => [k, t('conf.' + k)]), b.confidence);
    const reasons = h('textarea', { rows: 2, maxlength: 2000 }, b.reasons || '');
    const check = h('input', { type: 'date', value: b.checkAfter || '' });
    const isRef = h('input', { type: 'checkbox', checked: !!b.reference });
    const planCount = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: b.planCount ?? V.planFactor(wallet.settings(), { contactId: ev.body.actor, systemId: ev.body.systemId }) });
    const planOut = h('output', {}, pct(Number(planCount.value)));
    planCount.addEventListener('input', () => { planOut.textContent = pct(Number(planCount.value)); });
    let vet = b.vet || null;
    const vetLine = h('p', { class: 'vw-muted vw-small', 'aria-live': 'polite' });
    const useVet = h('button', { type: 'button', class: 'vw-link', hidden: true, onclick: () => { own.value = String(vet.totals.sumOut); ownU.value = t('vet.unit'); } }, t('vet.useOwn'));
    const showVet = () => {
      vetLine.textContent = vet ? t('vet.line', { out: num(vet.totals.sumOut ?? 0), in: num(vet.totals.sumIn ?? 0), n: vet.totals.count ?? 0 }) : t('vet.none');
      useVet.hidden = !(vet && Number.isFinite(vet.totals.sumOut));
    };
    showVet();
    const vetBtn = h('button', { type: 'button', class: 'vw-btn vw-ghost', onclick: async () => {
      const r = await openVet({ url: vetAddress(), payload: vetOpenPayload(wallet, ev, vet, { lang, labels: { title: phrase(ev), out: t('vet.out'), in: t('vet.in') } }),
        ui: { title: t('vet.title'), loading: t('vet.loading'), unsupported: t('vet.unsupported'), timeout: t('vet.timeout'), close: t('close') } });
      if (r) { vet = r; showVet(); }
    } }, t(vet ? 'vet.again' : 'vet.open'));
    refresh();
    return h('div', { class: 'vw-assess-layout' },
      orientation(ev.body.systemId, evRootId),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        const c = contribs.read(), sp = spent.read();
        const r = valueOf(c, sp);
        const body = { eventId: evRootId, phase: phaseSel.value, gained: lines(gained.value), lost: lines(lost.value), contributions: c, spent: sp, reference: isRef.checked, confidence: conf.value };
        if (rx !== null) body.reaction = rx;
        if (c.length) body.v = r.v;
        if (sp.length) body.spentV = r.spentV;
        if (own.value !== '' && !(rx !== null && b.ownScore && reactionOf({ ownScore: b.ownScore }) !== null && Number(own.value) === b.ownScore.value)) body.ownScore = { value: Number(own.value), ...(ownU.value.trim() ? { unit: ownU.value.trim() } : {}) };
        if (reasons.value.trim()) body.reasons = reasons.value.trim();
        if (check.value) body.checkAfter = check.value;
        if (hasPlan) body.planCount = Number(planCount.value);
        if (vet) body.vet = vet;
        const id = await guard(() => (existing ? wallet.correct(existing.rootId, body) : wallet.add('assessment', body)));
        close(true); render();
        if (id && c.length) feelingCheck(evRootId, wallet.rootOf(id), body, r);
      } },
      h('p', { class: 'vw-label' }, t('rx.q')), rxBox,
      field(t('as.gained'), gained, t('as.linesHint')), field(t('as.lost'), lost),
      // goals appear only when the holder has goals; reactions are calibrated by them later (owner, 2026-10-17)
      goalOptions().length ? h('fieldset', {}, h('legend', {}, t('as.goals')), contribs.node, h('button', { type: 'button', class: 'vw-link', onclick: () => { contribs.add(); refresh(); } }, t('as.addGoal'))) : null,
      goalOptions().length ? preview : null,
      field(t('as.reasons'), reasons),
      h('details', { class: 'vw-details' }, h('summary', {}, t('more')),
        field(t('as.phase'), phaseSel, canRetro ? null : t('as.retroHint')),
        h('fieldset', {}, h('legend', {}, t('as.spent')), h('p', { class: 'vw-hint' }, t('as.spentHint')),
          spent.node, h('button', { type: 'button', class: 'vw-link', onclick: () => { spent.add(); refresh(); } }, t('as.addSpent'))),
        h('fieldset', {}, h('legend', {}, t('vet.legend')), h('p', { class: 'vw-hint' }, t('vet.hint')), vetLine, h('div', { class: 'vw-actions' }, vetBtn, useVet)),
        h('div', { class: 'vw-inline' }, field(t('as.own'), own, t('as.ownHint')), field(t('as.unit'), ownU)),
        hasPlan ? field(t('as.planCount'), h('div', { class: 'vw-inline' }, planCount, planOut), t('as.planCountHint')) : null,
        h('div', { class: 'vw-inline' }, field(t('as.conf'), conf), field(t('as.check'), check, t('as.checkHint'))),
        h('label', { class: 'vw-check' }, isRef, h('span', {}, t('as.reference')))),
      submitRow()));
  });
}

function valueWords(r, systemId, eventId) {
  if (!r.parts.length) return t('val.none');
  const goals = Object.fromEntries(goalsForValue().map((g) => [g.id, g]));
  const main = r.parts.reduce((m, p) => (Math.abs(p.wk) > Math.abs(m.wk) ? p : m));
  let s = t(r.v < 0 ? 'val.harm' : 'val.moved', { k: pct(Math.abs(main.k)), goal: goals[main.goalId]?.title || '', w: pct(main.w), v: pct(Math.abs(r.v)) });
  if (r.spentV > 0) s += ' ' + t('val.spent', { s: pct(r.spentV), e: num(r.efficiency) });
  const near = r.v > 0 ? V.nearestReference(referencesFor(systemId, eventId).filter((x) => x.v > 0), r.v) : null;
  if (near) {
    const key = near.ratio >= 1.25 ? 'val.ref' : near.ratio > 0.8 ? 'val.refSame' : 'val.refLess';
    s += ' ' + t(key, { x: key === 'val.refLess' ? pct(near.ratio) : num(near.ratio), ref: near.phrase });
  }
  return s;
}

function rankWords(v) {
  const since = Date.now() - 30 * 86400000;
  const recent = assessments().filter((a) => Date.parse(a.createdAt) >= since && typeof a.body.v === 'number');
  if (recent.length < 3) return '';
  const better = recent.filter((a) => a.body.v > v).length;
  return better < 3 ? t('val.top3') : t('val.rank', { n: better + 1, of: recent.length });
}

async function feelingCheck(evRootId, assessRoot, body, r) {
  const ev = wallet.get(evRootId);
  const text = valueWords(r, ev.body.systemId, evRootId) + (r.v > 0 ? ' ' + rankWords(r.v) : '');
  const goals = goalsForValue();
  const hist = assessments().map((a) => ({ at: a.createdAt, v: a.body.v, ownScore: a.body.ownScore, contributions: a.body.contributions || [] }));
  const flags = V.feelingChecks(goals, hist);
  const ans = await modal(t('fc.title'), (close) => h('div', {},
    h('p', { class: 'vw-lead' }, text), h('p', {}, t('fc.q')),
    flags.map((f) => h('p', { class: 'vw-flag' }, t('flag.' + f.code, { goal: goals.find((g) => g.id === f.goalId)?.title || '' }))),
    h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn vw-primary', onclick: () => close('yes') }, t('fc.yes')),
      h('button', { class: 'vw-btn', onclick: () => close('less') }, t('fc.less')),
      h('button', { class: 'vw-btn', onclick: () => close('more') }, t('fc.more')))));
  if (ans === 'less' || ans === 'more') {
    toast(t(ans === 'less' ? 'fc.lessHint' : 'fc.moreHint'));
    assessDialog(evRootId, { ...wallet.get(assessRoot), rootId: assessRoot });
  }
}

// ---- share (P2P message, delivered as a file in L1) ----

function shareTarget(ev) {
  const me = selfId();
  if (ev.body.registryRef?.owner) return wallet.contactByAddress(ev.body.registryRef.owner)?.rootId || null;
  if (ev.body.actor !== me) return ev.body.actor;
  return (ev.body.affected || []).find((x) => x !== me) || null;
}

function shareDialog(ev, a, targetId) {
  const c = wallet.get(targetId);
  const card = c?.body.card?.card;
  return modal(t('sh.title', { name: c?.body.name || '' }), (close) => {
    if (!card) return h('div', {}, h('p', {}, t('sh.noCard', { name: c?.body.name || '' })), h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn', onclick: () => close(null) }, t('close'))));
    const st = card.storage || {};
    const publish = select([['no', t('sh.pub.no')], ...(st.publishes !== 'no' ? [['anonymous', t('sh.pub.anonymous')], ['named', t('sh.pub.named')]] : [])], 'no');
    const anon = h('input', { type: 'checkbox' });
    const plans = wallet.list('plan').filter((p) => p.body.eventId === ev.rootId);
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const b = a.body;
      const body = { kind: 'share', event: { actor: nameOf(ev.body.actor), action: ev.body.action, objects: (ev.body.objects || []).map((o) => o.label), affected: (ev.body.affected || []).map(objName), occurredAt: String(ev.body.occurredAt) }, phase: b.phase, gained: b.gained || [], lost: b.lost || [], publish: publish.value };
      if (ev.body.registryRef) body.event.registryRef = ev.body.registryRef;
      if (typeof b.v === 'number') body.v = b.v;
      if (b.spentV) body.spentV = b.spentV;
      if (ev.body.systemId) body.system = sysTitle(ev.body.systemId);
      if (plans.length && typeof b.v === 'number') { const pv = plans[0].body.plannedV; if (typeof pv === 'number') body.planGap = b.v < 0 ? 'harm' : b.v > pv * 1.1 ? 'above-plan' : b.v < pv * 0.9 ? 'below-plan' : 'as-planned'; }
      const msg = await guard(() => wallet.prepareShare(targetId, body, { about: a.rootId, anonymous: anon.checked }));
      if (msg) { close(true); render(); await handOver(msg, 'share_' + c.body.name); }
    } },
    h('div', { class: 'vw-card vw-policy' }, h('strong', {}, t('sh.policy')),
      h('p', {}, st.stores ? t('sh.stores', { p: st.purpose || '-', d: st.retentionDays ?? '-' }) : t('sh.notStores')),
      h('p', {}, t('sh.publishes.' + (st.publishes || 'no')))),
    field(t('sh.publish'), publish),
    h('label', { class: 'vw-check' }, anon, h('span', {}, t('sh.anon'))),
    h('p', { class: 'vw-hint' }, wallet.relayUrl() ? t('sh.viaRelay') : t('sh.delivery')),
    submitRow(t(wallet.relayUrl() ? 'sh.send' : 'sh.go')));
  });
}

async function handOver(msg, name) {
  if (await guard(() => wallet.deliver(msg))) { toast(t('rl.sent')); return; }
  download(`${slug(name)}_${today()}.vwmsg.json`, msg);
  toast(t('sh.ready'));
}

function receiptTarget(ev) {
  const id = shareTarget(ev);
  const c = id && wallet.get(id);
  return c && c.body.card && !ev.body.registryRef ? id : null;
}

function confirmDialog(ev, otherId) {
  const other = wallet.get(otherId);
  return modal(t('rc.title', { name: other.body.name }), (close) => {
    const mode = select([['attest', t('rc.mode.attest')], ['opinion', t('rc.mode.opinion')], ['binding', t('rc.mode.binding')]], 'attest');
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = t('create.wait');
      try {
        const arbUrl = (wallet.settings().arbiters || [])[0]?.url || AEVRI_ARBITER;
        let arbiter = null;
        if (mode.value !== 'attest') {
          const k = await (await fetch(arbUrl + '/key')).json();
          arbiter = { url: arbUrl, key: k.key };
        }
        const offer = await wallet.offerEvent(ev.rootId, otherId, { mode: mode.value, arbiter });
        close(true); render();
        await handOver(offer, other.body.name);
      } catch (err) { msg.textContent = t('rl.failed', { msg: err.message }); }
    } }, h('p', {}, t('rc.lead')), field(t('rc.mode'), mode, t('rc.modeHint')), msg, submitRow(t('rc.go')));
  });
}

function caseDialog(ev) {
  const bundle = ev.body.receipt;
  const m = bundle.receipt.mandate || {};
  const url = m.arbiter?.url || (wallet.settings().arbiters || [])[0]?.url || AEVRI_ARBITER;
  return modal(t('cs.title'), (close) => {
    const req = select([['attest', t('cs.request.attest')], ['opinion', t('cs.request.opinion')], ['decision', t('cs.request.decision')]], m.mode === 'binding' ? 'decision' : 'opinion');
    const st = h('textarea', { rows: 4, maxlength: 2000 });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = t('create.wait');
      try {
        await wallet.openCase(ev.rootId, { statement: st.value.trim(), request: req.value, arbiterUrl: url });
        close(true); toast(t('cs.sent')); render();
      } catch (err) { msg.textContent = String(err.code).endsWith('no-binding-mandate') || err.code === 409 ? t('cs.noBinding') : t('rl.failed', { msg: err.message }); }
    } }, h('p', {}, t('cs.lead')), field(t('cs.request'), req), field(t('cs.statement'), st), msg,
      h('p', { class: 'vw-small' }, h('a', { href: 'https://aeilus.institute/tools/vledger/arbiter-rules/', target: '_blank', rel: 'noopener' }, t('cs.rules'))),
      submitRow(t('cs.go')));
  });
}

// ---- contacts ----

function tabContacts() {
  const me = selfId();
  const link = C.addressLink(wallet.address, { name: wallet.doc.extensions.label || undefined, kind: 'person' });
  const qr = h('div', { class: 'vw-qr' });
  qr.innerHTML = qrSvg(link, { label: t('ct.qrLabel') });
  const s = wallet.settings();
  const blocked = new Set(s.requests?.blockContacts || []);
  const out = [
    h('div', { class: 'vw-card vw-me' },
      h('h2', {}, t('ct.myAddress')), qr,
      h('code', { class: 'vw-addr' }, wallet.address),
      h('div', { class: 'vw-actions' },
        h('button', { class: 'vw-btn', onclick: async () => { try { await navigator.clipboard.writeText(link); toast(t('copied')); } catch { prompt(t('ct.copyManual'), link); } } }, t('ct.copyLink')),
        h('button', { class: 'vw-btn', onclick: async () => download(`card_${slug(wallet.doc.extensions.label)}.vwcard.json`, await wallet.card()) }, t('ct.saveCard'))),
      h('p', { class: 'vw-hint' }, t('ct.myHint'))),
    h('div', { class: 'vw-toolbar' },
      h('button', { class: 'vw-btn vw-primary', onclick: () => contactDialog() }, t('ct.add')),
      h('button', { class: 'vw-btn', onclick: scanDialog }, t('ct.scan')),
      h('button', { class: 'vw-btn', onclick: async () => { const d = await pickFile(); if (d?.card) { await guard(() => wallet.addCard(d)); toast(t('ct.cardAdded')); render(); } else if (d) toast(t('ct.notCard')); } }, t('ct.importCard'))),
  ];
  const list = contacts().filter((c) => c.rootId !== me);
  if (!list.length) out.push(h('p', { class: 'vw-empty' }, t('ct.empty')));
  for (const type of ['person', 'organization', 'state', 'group', 'device', 'unknown']) {
    const group = list.filter((c) => c.body.type === type);
    if (!group.length) continue;
    out.push(h('h2', {}, t('cpt.' + type + '.many')));
    for (const c of group) {
      const n = events().filter((e) => involves(e, c)).length;
      out.push(h('article', { class: 'vw-card' },
        h('div', { class: 'vw-row' }, h('h3', {}, c.body.name), h('span', { class: 'vw-muted' }, t('ct.events', { n }))),
        c.body.address ? h('p', { class: 'vw-muted vw-small' }, short(c.body.address), c.body.card ? ' · ' + t('ct.hasCard') : ' · ' + t('ct.noCard')) : h('p', { class: 'vw-muted vw-small' }, t('ct.noAddress')),
        c.body.note ? h('p', {}, c.body.note) : null,
        h('div', { class: 'vw-actions' },
          h('button', { class: 'vw-btn', onclick: () => eventDialog(null, { actor: c.rootId, role: 'affected', affected: [me] }) }, t('ct.newEvent')),
          h('label', { class: 'vw-check vw-inline-check' }, h('input', { type: 'checkbox', checked: blocked.has(c.rootId), onchange: async (e) => {
            const cur = wallet.settings();
            const set = new Set(cur.requests?.blockContacts || []);
            if (e.target.checked) set.add(c.rootId); else set.delete(c.rootId);
            await guard(() => wallet.saveSettings({ ...cur, requests: { ...(cur.requests || {}), blockContacts: [...set] } }));
          } }), h('span', {}, t('ct.blockRequests'))),
          h('button', { class: 'vw-btn vw-ghost', onclick: () => contactDialog(c) }, t('edit')), itemMenu(c))));
    }
  }
  return out;
}

function contactDialog(c, preset = {}) {
  const b = c ? c.body : { type: 'person', ...preset };
  return modal(t(c ? 'ct.editTitle' : 'ct.addTitle'), (close) => {
    const type = select(['person', 'organization', 'state', 'group', 'device', 'unknown'].map((k) => [k, t('cpt.' + k)]), b.type);
    const name = h('input', { type: 'text', maxlength: 300, value: b.name || '' });
    const addr = h('input', { type: 'text', value: b.address || '', placeholder: 'vw1:... ' + t('ct.orLink') });
    const note = h('textarea', { rows: 2, maxlength: 2000 }, b.note || '');
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    addr.addEventListener('change', () => {
      const p = C.parseAddress(addr.value);
      if (p) { addr.value = p.address; if (p.name && !name.value) name.value = p.name; if (p.kind && ['person', 'organization', 'state', 'group', 'device'].includes(p.kind)) type.value = p.kind; }
    });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { msg.textContent = t('cp.needName'); return; }
      const body = { ...(c ? c.body : {}), type: type.value, name: name.value.trim() };
      if (addr.value.trim()) {
        const p = C.parseAddress(addr.value);
        if (!p) { msg.textContent = t('ct.badAddress'); return; }
        if (p.address === wallet.address) { msg.textContent = t('ct.isMe'); return; }
        body.address = p.address;
      } else delete body.address;
      if (note.value.trim()) body.note = note.value.trim(); else delete body.note;
      if (body.address && !body.card && wallet.relayUrl()) {
        const card = await wallet.lookupCard(body.address).catch(() => null);
        if (card) { body.card = card; toast(t('rl.cardFound')); }
      }
      await guard(() => (c ? wallet.correct(c.rootId, body) : wallet.add('contact', body)));
      close(true); render();
    } }, field(t('cp.type'), type), field(t('cp.name'), name), field(t('ct.address'), addr, t('ct.addressHint')), field(t('cp.note'), note), msg, submitRow());
  });
}

async function scanDialog() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    toast(t('ct.noScanner'));
    return contactDialog();
  }
  let stream = null, stop = false;
  const found = await modal(t('ct.scan'), (close) => {
    const video = h('video', { class: 'vw-video', playsinline: true, muted: true });
    const msg = h('p', { class: 'vw-hint' }, t('ct.scanHint'));
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream; await video.play();
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        while (!stop) {
          const codes = await det.detect(video).catch(() => []);
          const p = codes.map((x) => C.parseAddress(x.rawValue)).find(Boolean);
          if (p) { close(p); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { msg.textContent = t('ct.camError'); }
    })();
    return h('div', {}, video, msg);
  });
  stop = true;
  if (stream) stream.getTracks().forEach((tr) => tr.stop());
  if (found) contactDialog(null, { address: found.address, name: found.name || '', type: found.kind || 'person' });
}

// ---- systems, goals, facts ----

function tabSystems() {
  const om = V.systemWeights(systemsForValue(), goalsForValue());
  const w = V.goalWeights(goalsForValue(), systemsForValue());
  const goals = wallet.list('goal');
  const out = [h('p', { class: 'vw-hint' }, t('sys.lead')),
    h('div', { class: 'vw-toolbar' }, h('button', { class: 'vw-btn vw-primary', onclick: () => systemDialog() }, t('sys.add')), h('button', { class: 'vw-btn', onclick: () => goalDialog() }, t('goal.add')))];
  const block = (title, sysItem, sysGoals, share) => h('section', { class: 'vw-card' },
    h('div', { class: 'vw-row' }, h('h3', {}, title), h('span', { class: 'vw-chip' }, share != null ? t('sys.share', { w: pct(share) }) : t('gs.dropped'))),
    sysItem?.body.registryUrl ? h('p', { class: 'vw-muted vw-small' }, t('sys.follows', { url: sysItem.body.registryUrl })) : null,
    sysGoals.length ? sysGoals.map((g) => {
      const k = goalProgress(g.rootId);
      return h('div', { class: 'vw-goal' },
        h('div', { class: 'vw-row' }, h('span', {}, g.body.title, ' ', h('span', { class: 'vw-muted vw-small' }, t('goal.wLine', { w: pct(w[g.rootId] || 0) }))), h('span', { class: 'vw-chip' }, t('gs.' + g.body.status))),
        h('div', { class: 'vw-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(Math.max(0, Math.min(1, k)) * 100), 'aria-label': g.body.title }, h('span', { style: `width:${Math.max(0, Math.min(1, k)) * 100}%` })),
        h('div', { class: 'vw-actions' }, h('span', { class: 'vw-muted vw-small' }, t('goal.progressText', { k: pct(k) })), h('button', { class: 'vw-btn vw-ghost', onclick: () => goalDialog(g) }, t('edit')), itemMenu(g)));
    }) : h('p', { class: 'vw-muted' }, t('sys.noGoals')),
    sysItem ? h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-ghost', onclick: () => systemDialog(sysItem) }, t('edit')), itemMenu(sysItem)) : null);
  for (const s of systems()) out.push(block(`${s.body.title} · W ${num(s.body.W)}`, s, goals.filter((g) => g.body.systemId === s.rootId), s.body.status === 'active' ? om[s.rootId] : null));
  const known = new Set(systems().map((s) => s.rootId));
  const loose = goals.filter((g) => !g.body.systemId || !known.has(g.body.systemId));
  if (loose.length) out.push(block(t('sys.other'), null, loose, om[V.OTHER] ?? null));
  out.push(h('h2', {}, t('tab.facts')), h('p', { class: 'vw-hint' }, t('fact.lead')), h('button', { class: 'vw-btn', onclick: () => factDialog() }, t('fact.add')));
  for (const f of wallet.list('fact').sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const gs = (f.body.goalIds || []).map((id) => wallet.get(id)?.body.title).filter(Boolean);
    out.push(h('article', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('span', { class: 'vw-muted' }, f.body.topic || ''), h('span', { class: 'vw-chip' }, t('conf.' + f.body.certainty) + (f.body.exploring ? ' · ' + t('fact.exploring') : ''))),
      h('p', {}, f.body.text), gs.length ? h('p', { class: 'vw-muted' }, t('fact.goals') + ': ' + gs.join(', ')) : null,
      h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-ghost', onclick: () => factDialog(f) }, t('fact.revise')), itemMenu(f))));
  }
  return out;
}

function systemDialog(s) {
  const b = s ? s.body : { status: 'active', W: 1 };
  return modal(t(s ? 'sys.editTitle' : 'sys.addTitle'), (close) => {
    const title = h('input', { type: 'text', maxlength: 300, value: b.title || '', placeholder: t('sys.titlePh') });
    const W = h('input', { type: 'number', step: 'any', min: 0, value: b.W });
    const status = select(['active', 'dropped'].map((k) => [k, t('gs.' + k)]), b.status);
    const note = h('textarea', { rows: 2, maxlength: 2000 }, b.note || '');
    const groups = [...new Set(systems().map(groupOf))];
    const group = h('input', { type: 'text', maxlength: 100, list: 'vw-groups', value: b.group || (s ? groupOf(s) : ''), placeholder: t('life.groupPh') });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!title.value.trim()) { msg.textContent = t('sys.needTitle'); return; }
      if (!(Number(W.value) > 0)) { msg.textContent = t('sys.needW'); return; }
      const body = { ...(s ? s.body : {}), title: title.value.trim(), W: Number(W.value), status: status.value };
      if (group.value.trim()) body.group = group.value.trim().slice(0, 100); else delete body.group;
      if (note.value.trim()) body.note = note.value.trim(); else delete body.note;
      await guard(() => (s ? wallet.correct(s.rootId, body) : wallet.add('value-system', body)));
      close(true); render();
    } }, h('datalist', { id: 'vw-groups' }, groups.map((g) => h('option', { value: g }))), field(t('sys.title'), title), field(t('life.group'), group, t('life.groupHint')), field(t('sys.W'), W, t('sys.WHint')), field(t('goal.status'), status), field(t('cp.note'), note), msg, submitRow());
  });
}

function goalDialog(g) {
  const b = g ? g.body : { status: 'active' };
  return modal(t(g ? 'goal.editTitle' : 'goal.addTitle'), (close) => {
    const title = h('input', { type: 'text', maxlength: 300, value: b.title || '' });
    const sys = select([['', t('sys.other')], ...systems().map((s) => [s.rootId, s.body.title])], b.systemId || '');
    const why = h('textarea', { rows: 2, maxlength: 2000 }, b.why || '');
    const S = h('input', { type: 'number', step: 'any', min: 0, value: b.S ?? '' });
    const N = h('input', { type: 'number', step: 'any', min: 0, value: b.N ?? '' });
    const unit = h('input', { type: 'text', maxlength: 40, value: b.unit || '' });
    const status = select(['active', 'reached', 'dropped'].map((k) => [k, t('gs.' + k)]), b.status);
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!title.value.trim()) { msg.textContent = t('goal.needTitle'); return; }
      if (!(Number(S.value) > 0)) { msg.textContent = t('goal.needS'); return; }
      if (N.value !== '' && !(Number(N.value) > 0)) { msg.textContent = t('goal.needN'); return; }
      const body = { title: title.value.trim(), S: Number(S.value), status: status.value, factIds: b.factIds || [] };
      if (sys.value) body.systemId = sys.value;
      if (N.value !== '') body.N = Number(N.value);
      if (why.value.trim()) body.why = why.value.trim();
      if (unit.value.trim()) body.unit = unit.value.trim();
      await guard(() => (g ? wallet.correct(g.rootId, body) : wallet.add('goal', body)));
      close(true); render();
    } },
    field(t('goal.title'), title), field(t('goal.system'), sys), field(t('goal.why'), why),
    h('div', { class: 'vw-inline' }, field(t('goal.S'), S, t('goal.SHint')), field(t('goal.N'), N, t('goal.NHint')), field(t('goal.unit'), unit)),
    field(t('goal.status'), status), msg, submitRow());
  });
}

function factDialog(f) {
  const b = f ? f.body : { certainty: 'medium', exploring: false, goalIds: [] };
  return modal(t(f ? 'fact.editTitle' : 'fact.addTitle'), (close) => {
    const topic = h('input', { type: 'text', maxlength: 100, value: b.topic || '' });
    const text = h('textarea', { rows: 4, maxlength: 2000 }, b.text || '');
    const cert = select(['low', 'medium', 'high'].map((k) => [k, t('conf.' + k)]), b.certainty);
    const exploring = h('input', { type: 'checkbox', checked: !!b.exploring });
    const boxes = wallet.list('goal').map((g) => h('label', { class: 'vw-check' }, h('input', { type: 'checkbox', value: g.rootId, checked: (b.goalIds || []).includes(g.rootId) }), h('span', {}, g.body.title)));
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!text.value.trim()) { msg.textContent = t('fact.need'); return; }
      const body = { text: text.value.trim(), certainty: cert.value, exploring: exploring.checked, goalIds: boxes.map((x) => x.querySelector('input')).filter((x) => x.checked).map((x) => x.value) };
      if (topic.value.trim()) body.topic = topic.value.trim();
      await guard(() => (f ? wallet.correct(f.rootId, body) : wallet.add('fact', body)));
      close(true); render();
    } }, field(t('fact.topic'), topic), field(t('fact.text'), text),
    h('div', { class: 'vw-inline' }, field(t('fact.certainty'), cert), h('label', { class: 'vw-check' }, exploring, h('span', {}, t('fact.exploringLong')))),
    boxes.length ? h('fieldset', {}, h('legend', {}, t('fact.goals')), boxes) : null, msg, submitRow());
  });
}

// ---- analytics ----

function tabAnalytics() {
  const per = select([['30', t('an.p30')], ['90', t('an.p90')], ['365', t('an.p365')], ['all', t('an.pAll')]], period);
  per.setAttribute('aria-label', t('an.period'));
  per.addEventListener('change', () => { period = per.value; render(); });
  const since = period === 'all' ? '' : new Date(Date.now() - Number(period) * 86400000).toISOString().slice(0, 10);
  const evs = events().filter((e) => !since || String(e.body.occurredAt).slice(0, 10) >= since).map(withOwner);
  const as = assessments().map((a) => ({ ...a.body, createdAt: a.createdAt }));
  const an = V.analytics(evs, as, selfId());
  const om = V.systemWeights(systemsForValue(), goalsForValue());
  const totalV = an.total.all?.v || 0;
  const table = (title, group, label, extra) => {
    const rows = Object.entries(group).sort((a, b) => b[1].v - a[1].v);
    return h('section', {}, h('h2', {}, title), rows.length ? h('div', { class: 'vw-table-wrap' }, h('table', { class: 'vw-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('an.events')), h('th', {}, t('an.assessed')), h('th', {}, t('an.v')), h('th', {}, t('an.spent')), h('th', {}, t('an.eff')), extra ? h('th', {}, extra.head) : null)),
      h('tbody', {}, rows.map(([k, g]) => h('tr', {}, h('th', { scope: 'row' }, label(k)), h('td', {}, g.events), h('td', {}, g.assessed), h('td', {}, pct(g.v)), h('td', {}, pct(g.spentV)), h('td', {}, g.efficiency == null ? '-' : num(g.efficiency)), extra ? h('td', {}, extra.cell(k, g)) : null))))) : h('p', { class: 'vw-muted' }, t('an.none')));
  };
  return [
    h('div', { class: 'vw-toolbar' }, per),
    reactionsSection(events().filter((e) => !since || String(e.body.occurredAt).slice(0, 10) >= since)),
    h('h2', {}, t('an.byGoals')),
    h('p', { class: 'vw-hint' }, t('an.lead')),
    h('div', { class: 'vw-kpis' },
      h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, String(an.total.all?.events || 0)), h('div', { class: 'vw-muted' }, t('an.events'))),
      h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, pct(totalV)), h('div', { class: 'vw-muted' }, t('an.v'))),
      h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, an.total.all?.efficiency == null ? '-' : num(an.total.all.efficiency)), h('div', { class: 'vw-muted' }, t('an.eff')))),
    table(t('an.bySystem'), an.bySystem, (k) => (k === 'none' ? t('sys.none') : sysTitle(k)), { head: t('an.weightVsValue'), cell: (k, g) => `${pct(om[k] ?? 0)} / ${totalV ? pct(g.v / totalV) : '-'}` }),
    table(t('an.byContact'), an.byContact, (k) => nameOf(k)),
    table(t('an.byAction'), an.byAction, (k) => k || '-'),
    table(t('an.byRole'), an.byRole, (k) => t('role.' + k)),
  ];
}

// Reactions in aggregate (owner, 2026-10-17): what is assessed, how, where, when; what gave most, what wasted time
function reactionsSection(evs) {
  const rxs = assessments().map((a) => ({ eventId: a.body.eventId, phase: a.body.phase, reaction: reactionOf(a.body), createdAt: a.createdAt })).filter((r) => r.reaction !== null);
  const st = V.reactionStats(evs.map((e) => ({ id: e.rootId, occurredAt: e.body.occurredAt, systemId: e.body.systemId })), rxs);
  const T = st.total;
  const share = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '-');
  const bar = (g) => h('div', { class: 'vw-rxbar', role: 'img', 'aria-label': V.REACTION_SCALE.map((v) => `${t('rx.' + v)}: ${g.dist[v]}`).join(', ') },
    V.REACTION_SCALE.filter((v) => g.dist[v]).map((v) => h('span', { class: 'rx' + String(v).replace('-', 'm'), style: `flex:${g.dist[v]}`, title: `${t('rx.' + v)}: ${g.dist[v]}` })));
  const evLine = (x) => {
    const ev = wallet.get(x.id);
    if (!ev) return null;
    const it = registryItem(ev);
    return h('li', {}, h('span', { class: 'vw-chip' + (x.reaction < 0 ? ' vw-neg' : '') }, t('rx.' + x.reaction)), ' ', it?.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, phrase(ev)) : phrase(ev),
      h('span', { class: 'vw-muted vw-small' }, ' · ' + String(ev.body.occurredAt).slice(0, 10)));
  };
  if (!T.events) return h('section', {}, h('h2', {}, t('an.rx')), h('p', { class: 'vw-muted' }, t('an.none')));
  const months = Object.keys(st.byMonth).sort().reverse().slice(0, 12);
  return h('section', {},
    h('h2', {}, t('an.rx')),
    h('div', { class: 'vw-kpis' },
      h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, `${T.assessed} / ${T.events}`), h('div', { class: 'vw-muted' }, t('an.rxAssessed', { p: share(T.assessed, T.events) }))),
      h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, String(T.dist[500])), h('div', { class: 'vw-muted' }, t('rx.500'))),
      h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, share(T.useful, T.assessed)), h('div', { class: 'vw-muted' }, t('an.rxUseful'))),
      h('div', { class: 'vw-kpi' }, h('div', { class: 'vw-kpi-n' }, String(T.wasted)), h('div', { class: 'vw-muted' }, t('an.rxWasted')))),
    T.assessed ? [bar(T), h('ul', { class: 'vw-rxlegend' }, V.REACTION_SCALE.map((v) => h('li', {}, h('i', { class: 'rx' + String(v).replace('-', 'm'), 'aria-hidden': 'true' }), `${t('rx.' + v)} ${T.dist[v]}`)))] : h('p', { class: 'vw-muted' }, t('an.rxNone')),
    h('h3', {}, t('an.bySystem')),
    h('div', { class: 'vw-table-wrap' }, h('table', { class: 'vw-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('an.rxCol.assessed')), h('th', { class: 'vw-wide' }, t('an.rxCol.dist')), h('th', {}, t('an.rxCol.useful')), h('th', {}, t('an.rxCol.wasted')))),
      h('tbody', {}, Object.entries(st.bySystem).sort((a, b) => b[1].events - a[1].events).map(([k, g]) => h('tr', {},
        h('th', { scope: 'row' }, k === 'none' ? t('sys.none') : sysTitle(k)), h('td', {}, `${g.assessed} / ${g.events}`), h('td', {}, g.assessed ? bar(g) : '-'),
        h('td', {}, share(g.useful, g.assessed)), h('td', {}, String(g.wasted))))))),
    months.length ? [h('h3', {}, t('an.rxByMonth')), h('div', { class: 'vw-table-wrap' }, h('table', { class: 'vw-table' },
      h('tbody', {}, months.map((m) => h('tr', {}, h('th', { scope: 'row' }, m), h('td', {}, String(st.byMonth[m].assessed)), h('td', { class: 'vw-wide' }, bar(st.byMonth[m])))))))] : null,
    st.best.length ? [h('h3', {}, t('an.rxBest')), h('ul', { class: 'vw-rxlist' }, st.best.slice(0, 10).map(evLine))] : null,
    st.wasted.length ? [h('h3', {}, t('an.rxWasteList')), h('ul', { class: 'vw-rxlist' }, st.wasted.slice(0, 10).map(evLine))] : null,
    T.events > T.assessed ? h('p', {}, h('button', { class: 'vw-btn', onclick: () => { const done = new Set(rxs.map((r) => r.eventId)); queueDialog(evs.filter((e) => !done.has(e.rootId) && !assessments().some((a) => a.body.eventId === e.rootId)).map((e) => e.rootId)); } }, t('an.rxQueue', { n: T.events - T.assessed }))) : null);
}

// ---- inbox ----

function tabInbox() {
  const sugg = events(true).filter((e) => e.body.status === 'suggested');
  const msgs = wallet.list('message-in').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const out = [h('div', { class: 'vw-toolbar' },
    wallet.relayUrl() ? h('button', { class: 'vw-btn vw-primary', onclick: () => checkMessages(false) }, t('rl.check')) : null,
    h('button', { class: 'vw-btn', onclick: async () => { const d = await pickFile(); if (d) await receiveMessage(d); } }, t('in.open')))];
  out.push(h('h2', {}, t('in.suggested')));
  if (!sugg.length) out.push(h('p', { class: 'vw-muted' }, t('in.noSuggested')));
  for (const e of sugg) {
    out.push(h('article', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('h3', {}, phrase(e)), h('span', { class: 'vw-chip' }, t('in.from', { name: nameOf(e.body.suggestedBy) }))),
      h('div', { class: 'vw-actions' },
        h('button', { class: 'vw-btn vw-primary', onclick: async () => { await guard(() => wallet.correct(e.rootId, { ...e.body, status: 'confirmed' })); render(); } }, t('in.confirm')),
        h('button', { class: 'vw-btn', onclick: () => eventDialog(null, { ...e.body }).then(async (id) => { if (id) { await wallet.correct(e.rootId, { ...e.body, status: 'rejected' }); render(); } }) }, t('in.editConfirm')),
        h('button', { class: 'vw-btn vw-ghost', onclick: async () => { await guard(() => wallet.correct(e.rootId, { ...e.body, status: 'rejected' })); render(); } }, t('in.reject')))));
  }
  out.push(h('h2', {}, t('in.messages')));
  if (!msgs.length) out.push(h('p', { class: 'vw-muted' }, t('in.noMessages')));
  for (const m of msgs) {
    const b = m.body.body;
    const sender = m.body.from ? (wallet.contactByAddress(m.body.from)?.body.name || short(m.body.from)) : t('in.anonymous');
    const words = b.event ? `${b.event.actor} ${b.event.action} ${(b.event.objects || []).join(', ')}`
      : (b.kind === 'event-offer' && b.opening ? `${b.opening.action.text} ${(b.opening.objects || []).map((o) => o.label).join(', ')} (${String(b.opening.occurredAt).slice(0, 10)})` : '');
    const acts = [];
    if (b.kind === 'request') acts.push(h('button', { class: 'vw-btn vw-primary', onclick: () => answerRequest(m) }, t('in.answer')));
    if (b.kind === 'event-offer' && b.opening && m.body.state === 'new') acts.push(h('button', { class: 'vw-btn vw-primary', onclick: async () => {
      const r = await guard(() => wallet.acceptOffer(m.rootId));
      if (!r) return;
      toast(t('rc.accepted'));
      if (r.reply) await handOver(r.reply, 'confirmation');
      render();
    } }, t('rc.accept')));
    if (b.kind === 'card') acts.push(h('button', { class: 'vw-btn vw-primary', onclick: async () => { await guard(() => wallet.addCard(b.card)); await wallet.setMessageState(m.rootId, 'accepted'); render(); } }, t('in.addContact')));
    if (m.body.state === 'new') acts.push(h('button', { class: 'vw-btn vw-ghost', onclick: async () => { await wallet.setMessageState(m.rootId, b.kind === 'share' ? 'accepted' : 'ignored'); render(); } }, t(b.kind === 'share' ? 'in.read' : 'in.ignore')));
    out.push(h('article', { class: 'vw-card' + (m.body.state === 'new' ? ' vw-new' : '') },
      h('div', { class: 'vw-row' }, h('h3', {}, t('in.kind.' + b.kind)), h('span', { class: 'vw-chip' }, sender + (m.body.verified ? ' ✓' : ''))),
      words ? h('p', {}, words) : null,
      b.kind === 'share' ? [typeof b.v === 'number' ? h('p', { class: 'vw-v' }, t('val.short', { v: pct(b.v) })) : null, (b.gained || []).map((x) => h('div', { class: 'vw-gained' }, '+ ' + x)), (b.lost || []).map((x) => h('div', { class: 'vw-lost' }, '- ' + x)), h('p', { class: 'vw-muted vw-small' }, t('in.publish.' + b.publish))] : null,
      b.kind === 'request' && b.plan?.promise ? h('p', { class: 'vw-plan' }, t('reg.promise', { p: b.plan.promise })) : null,
      b.kind === 'suggestion' ? h('p', { class: 'vw-muted' }, t('in.suggestionNote', { n: b.events.length })) : null,
      h('div', { class: 'vw-actions' }, acts)));
  }
  return out;
}

async function receiveMessage(doc) {
  if (doc.type !== 'aevri.vledger.message') { toast(t('in.notMessage')); return; }
  const r = await guard(() => wallet.receive(doc));
  if (!r) return;
  toast(r.dropped ? t('in.dropped') : t('in.received'));
  tab = 'inbox'; render();
}

async function answerRequest(m) {
  const b = m.body.body;
  const me = selfId();
  const sender = m.body.from ? wallet.contactByAddress(m.body.from) : null;
  const senderId = sender ? sender.rootId : await wallet.add('contact', { type: 'organization', name: b.event?.actor && !/^(me|я)$/i.test(b.event.actor) ? b.event.actor : t('cp.unknown'), ...(m.body.from ? { address: m.body.from } : {}) });
  const sys = b.systemRegistryUrl ? systems().find((s) => s.body.registryUrl === b.systemRegistryUrl) : systems().find((s) => s.body.title.toLowerCase() === String(b.system || '').toLowerCase());
  const meActs = /^(me|я)$/i.test(b.event?.actor || '');
  const evId = await eventDialog(null, { role: meActs ? 'user' : 'affected', actor: meActs ? me : senderId, action: b.event?.action || '', objects: (b.event?.objects || []).map((label) => ({ label })), affected: meActs ? [] : [me], systemId: sys?.rootId, registryRef: b.event?.registryRef });
  if (!evId) return;
  if (b.plan?.promise) await wallet.add('plan', { eventId: evId, author: senderId, promise: b.plan.promise, ...(typeof b.plan.plannedV === 'number' ? { plannedV: b.plan.plannedV } : {}) }, { source: 'message' });
  await wallet.setMessageState(m.rootId, 'accepted');
  render();
  assessDialog(evId, null, { phase: 'realized' });
}

// ---- settings ----

function relaySection() {
  const s = wallet.settings();
  const on = (s.relays || []).length > 0;
  const url = h('input', { type: 'url', value: (s.relays || [])[0] || AEVRI_RELAY });
  const box = h('input', { type: 'checkbox', checked: on, onchange: async (e) => {
    const relays = e.target.checked ? [url.value.trim().replace(/\/$/, '') || AEVRI_RELAY] : [];
    await guard(() => wallet.saveSettings({ ...wallet.settings(), relays }));
    toast(t('saved')); render();
    if (relays.length) checkMessages(false);
  } });
  const pol = h('p', { class: 'vw-hint' });
  if (on) new RelayClient((s.relays || [])[0]).policy().then((p) => { if (p) pol.textContent = t('rl.policy', { days: p.maxHoldDays }); }).catch(() => {});
  return [
    h('h2', {}, t('rl.title')), h('p', { class: 'vw-hint' }, t('rl.lead')),
    h('label', { class: 'vw-check' }, box, h('span', {}, t('rl.use'))),
    h('details', {}, h('summary', {}, t('rl.other')), field(t('rl.url'), url, t('rl.urlHint'))),
    pol,
    on ? h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn', onclick: () => checkMessages(false) }, t('rl.check')),
      h('button', { class: 'vw-btn', onclick: async () => { if (await guard(() => wallet.publishCard())) toast(t('rl.published')); } }, t('rl.publish')),
      h('button', { class: 'vw-btn vw-ghost', onclick: async () => { if (await guard(() => wallet.withdrawCard())) toast(t('rl.withdrawn')); } }, t('rl.withdraw'))) : null,
    on ? h('p', { class: 'vw-hint' }, t('rl.publishHint')) : null,
  ];
}

// Device biometrics in settings (SPEC 18): on where the browser gives a key (PRF), otherwise the passphrase as before
function bioSection() {
  const box = h('div', { class: 'vw-card' }, h('p', { class: 'vw-muted' }, t('bio.checking')));
  const draw = async () => {
    if (!Bio.available()) { box.replaceChildren(h('strong', {}, t('bio.title')), h('p', { class: 'vw-hint' }, t('bio.unsupported'))); return; }
    const rec = await biometricKeys.get(wallet.id).catch(() => null);
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    if (rec) {
      box.replaceChildren(h('strong', {}, t('bio.title')), h('p', {}, t('bio.on', { date: rec.createdAt.slice(0, 10) })),
        h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn', onclick: async () => { await biometricKeys.remove(wallet.id); toast(t('bio.offDone')); draw(); } }, t('bio.off'))),
        h('p', { class: 'vw-hint' }, t('bio.offHint')));
      return;
    }
    box.replaceChildren(h('strong', {}, t('bio.title')), h('p', { class: 'vw-hint' }, t('bio.lead')), msg,
      h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', onclick: async () => {
        msg.textContent = t('bio.wait');
        try {
          await biometricKeys.put(await Bio.enroll(wallet.session, { label: wallet.doc.extensions.label || t('app.name') }));
          toast(t('bio.onDone')); draw();
        } catch (e) { msg.textContent = e.code === 'no-prf' ? t('bio.noPrf') : t('bio.failed'); }
      } }, t('bio.enable'))));
  };
  draw();
  return box;
}

function tabSettings() {
  const s = wallet.settings();
  const req = s.requests || {};
  const saveReq = async (patch) => { const cur = wallet.settings(); await guard(() => wallet.saveSettings({ ...cur, requests: { ...(cur.requests || {}), ...patch } })); toast(t('saved')); };
  const def = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.planCountDefault });
  const defOut = h('output', {}, pct(s.planCountDefault));
  def.addEventListener('input', () => { defOut.textContent = pct(Number(def.value)); });
  def.addEventListener('change', async () => { await guard(() => wallet.saveSettings({ ...wallet.settings(), planCountDefault: Number(def.value) })); toast(t('saved')); });
  const blockAll = h('input', { type: 'checkbox', checked: !!req.blockAll, onchange: (e) => saveReq({ blockAll: e.target.checked }) });
  const sysBoxes = systems().map((x) => h('label', { class: 'vw-check' }, h('input', { type: 'checkbox', checked: (req.blockSystems || []).includes(x.rootId), onchange: (e) => {
    const set = new Set(wallet.settings().requests?.blockSystems || []);
    if (e.target.checked) set.add(x.rootId); else set.delete(x.rootId);
    saveReq({ blockSystems: [...set] });
  } }), h('span', {}, x.body.title)));
  const st = s.storage || { stores: false, publishes: 'no' };
  const stStores = h('input', { type: 'checkbox', checked: !!st.stores });
  const stPurpose = h('input', { type: 'text', maxlength: 300, value: st.purpose || '' });
  const stDays = h('input', { type: 'number', min: 0, value: st.retentionDays ?? '' });
  const stPub = select(['no', 'anonymous', 'named', 'sender-choice'].map((k) => [k, t('sh.publishes.' + k)]), st.publishes);
  const types = wallet.list('element-type');
  const vssShare = select([['fact', t('br.share.fact')], ['value', t('br.share.value')]], s.bridges?.vss?.share === 'value' ? 'value' : 'fact');
  vssShare.addEventListener('change', async () => { const cur = wallet.settings(); await guard(() => wallet.saveSettings({ ...cur, bridges: { ...(cur.bridges || {}), vss: { share: vssShare.value } } })); toast(t('saved')); });
  return [
    relaySection(),
    h('h2', {}, t('br.title')), h('p', { class: 'vw-hint' }, t('br.lead')), field(t('br.share'), vssShare),
    h('h2', {}, t('set.requests')), h('p', { class: 'vw-hint' }, t('set.requestsHint')),
    h('label', { class: 'vw-check' }, blockAll, h('span', {}, t('set.blockAll'))),
    sysBoxes.length ? h('fieldset', {}, h('legend', {}, t('set.blockSystems')), sysBoxes) : null,
    h('p', { class: 'vw-hint' }, t('set.blockContactsHint')),
    h('h2', {}, t('set.plan')), h('p', { class: 'vw-hint' }, t('set.planHint')),
    field(t('set.planDefault'), h('div', { class: 'vw-inline' }, def, defOut)),
    h('h2', {}, t('set.myPolicy')), h('p', { class: 'vw-hint' }, t('set.myPolicyHint')),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const storage = { stores: stStores.checked, publishes: stPub.value };
      if (stPurpose.value.trim()) storage.purpose = stPurpose.value.trim();
      if (stDays.value !== '') storage.retentionDays = Number(stDays.value);
      await guard(() => wallet.saveSettings({ ...wallet.settings(), storage })); toast(t('saved'));
    } }, h('label', { class: 'vw-check' }, stStores, h('span', {}, t('set.stores'))), field(t('set.purpose'), stPurpose), field(t('set.days'), stDays), field(t('set.publishes'), stPub), submitRow()),
    h('h2', {}, t('set.types')),
    types.map((x) => h('div', { class: 'vw-row' }, h('span', {}, `${x.body.name} · ${t('cat.' + x.body.category)}`), itemMenu(x))),
    h('button', { class: 'vw-btn', onclick: typeDialog }, t('set.addType')),
    providersSection(),
    h('h3', {}, t('set.files')),
    h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn', onclick: () => download(`${slug(wallet.doc.extensions.label)}_${today()}.vledger.json`, wallet.exportEncrypted()) }, t('set.exportEnc')),
      h('button', { class: 'vw-btn', onclick: () => { if (confirm(t('set.readableWarn'))) download(`${slug(wallet.doc.extensions.label)}_${today()}_READABLE.json`, wallet.exportReadable()); } }, t('set.exportRead')),
      h('button', { class: 'vw-btn', onclick: importDialog }, t('set.import'))),
    h('h2', {}, t('set.security')),
    bioSection(),
    h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn', onclick: async () => { const p = await wallet.verify(); toast(p.length ? t('set.chainBad', { n: p.length }) : t('set.chainOk')); } }, t('set.verify')),
      h('button', { class: 'vw-btn', onclick: passDialog }, t('set.changePass')),
      h('button', { class: 'vw-btn', onclick: lockNow }, t('lock'))),
    h('h2', {}, t('set.danger')),
    h('button', { class: 'vw-btn vw-danger', onclick: async () => {
      if (!confirm(t('set.removeConfirm'))) return;
      await guard(() => device.remove(wallet.id)); await biometricKeys.remove(wallet.id).catch(() => {}); lockNow(); toast(t('set.removed'));
    } }, t('set.remove')),
    h('p', { class: 'vw-muted vw-small' }, t('set.about', { id: wallet.id, n: wallet.doc.records.length })),
  ];
}

function typeDialog() {
  return modal(t('type.title'), (close) => {
    const name = h('input', { type: 'text', maxlength: 300 });
    const cat = select(['thing', 'service', 'information', 'time', 'money', 'right', 'decision', 'relation', 'action', 'other'].map((k) => [k, t('cat.' + k)]), 'thing');
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      await guard(() => wallet.add('element-type', { name: name.value.trim(), category: cat.value }));
      close(true); render();
    } }, field(t('type.name'), name), field(t('type.category'), cat), submitRow());
  });
}

function passDialog() {
  return modal(t('set.changePass'), (close) => {
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!passphraseOk(p1.value)) { msg.textContent = t('create.weak'); return; }
      if (p1.value !== p2.value) { msg.textContent = t('create.mismatch'); return; }
      msg.textContent = t('create.wait');
      await guard(() => wallet.changePassphrase(p1.value));
      p1.value = p2.value = '';
      close(true); toast(t('set.passChanged'));
    } }, h('p', { class: 'vw-hint' }, t('set.passHint')), field(t('create.pass'), p1), field(t('create.pass2'), p2), msg, submitRow());
  });
}

// ---- shell ----

async function render() {
  const app = $app();
  const langSel = select(LANGS.map((x) => [x, x.toUpperCase()]), lang);
  langSel.setAttribute('aria-label', t('language'));
  langSel.addEventListener('change', async (e) => { await loadLang(e.target.value); render(); });
  const head = h('header', { class: 'vw-head' },
    h('div', { class: 'vw-brand' }, h('span', { class: 'vw-logo', 'aria-hidden': 'true' }, 'Æ'), h('span', {}, t('app.name'))),
    h('div', { class: 'vw-headr' }, wallet ? h('span', { class: 'vw-muted' }, wallet.doc.extensions.label || '') : null, langSel,
      wallet ? h('button', { class: 'vw-btn vw-ghost', onclick: lockNow }, t('lock')) : null));
  const main = h('main', { class: 'vw-main' }, wallet ? renderWallet() : await renderStart());
  const foot = h('footer', { class: 'vw-foot' }, h('span', {}, wallet ? t('foot.unlocked') : t('foot.locked')), ' ', h('a', { href: 'https://aeilus.institute/tools/' }, 'ÆVRI'));
  app.replaceChildren(head, main, foot);
  if (wallet && pending) setTimeout(runPending, 0);
  if (wallet) vss.ready();
}

export async function start() {
  let saved = null;
  try { saved = localStorage.getItem('vledger.lang'); } catch { /* ignore */ }
  const siteLang = document.querySelector('meta[name="aevri-lang"]')?.content; // set by the institute page for /xx/ addresses
  await loadLang(saved || (LANGS.includes(siteLang) ? siteLang : null) || (navigator.language || 'en').slice(0, 2));
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  await render();
}

export const _test = { get wallet() { return wallet; }, render, setVetUrl(u) { vetUrl = u; } };
if (new URLSearchParams(location.search).has('selftest')) window.vledgerTest = _test; // tests that embed the page in a frame
