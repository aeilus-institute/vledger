// Value Wallet L1 UI (format aevri.vledger 1.0-d2). Plain DOM, no framework.
// Timeline of events "someone did something with something or someone", contacts with addresses and QR,
// value systems and goals, assessments with references and spent value, inbox, analytics, settings.

import { Wallet, device, passphraseOk, inspectImport, pendingRecovery } from './vledger-store.js';
import { makeProvider, restoreCode, parseRestoreCode, AEVRI_URL, AEVRI_RELAY, AEVRI_ARBITER, RelayClient } from './vledger-providers.js';
import * as V from './vledger-value.js';
import * as C from './vledger-crypto.js';
import { qrSvg } from './vledger-qr.js';

const LANGS = ['en', 'ru'];
let L = {};
let lang = 'en';
let wallet = null;
let tab = 'timeline';
let filters = { system: '', role: '', contact: '' };
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
  L = await (await fetch(new URL('./locales/' + lang + '.json', import.meta.url))).json();
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

async function renderStart() {
  const list = await guard(() => device.list()) || [];
  const box = h('div', { class: 'vw-start' },
    h('p', { class: 'vw-lead' }, t('start.lead')),
    h('ul', { class: 'vw-facts' }, h('li', {}, t('start.f1')), h('li', {}, t('start.f2')), h('li', {}, t('start.f3'))));
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
    return h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; msg.textContent = t('unlock.wait');
      try {
        wallet = await Wallet.unlock(doc || await device.get(walletId), pass.value);
        pass.value = '';
        close(true); touch(); render(); syncAll(true);
      } catch { msg.textContent = t('unlock.wrong'); btn.disabled = false; }
    } }, field(t('unlock.pass'), pass), msg, h('div', { class: 'vw-actions' }, btn));
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
      wallet = await guard(() => Wallet.create(p1.value, { label: label.value.trim() }));
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

const TABS = ['timeline', 'contacts', 'systems', 'analytics', 'inbox', 'settings'];

function renderWallet() {
  const inboxCount = events(true).filter((e) => e.body.status === 'suggested').length + wallet.list('message-in').filter((m) => m.body.state === 'new').length;
  const nav = h('nav', { class: 'vw-tabs', role: 'tablist' }, TABS.map((k) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'is-on' : '', onclick: () => { tab = k; render(); } },
      t('tab.' + k), k === 'inbox' && inboxCount ? h('span', { class: 'vw-badge' }, String(inboxCount)) : null)));
  const body = { timeline: tabTimeline, contacts: tabContacts, systems: tabSystems, analytics: tabAnalytics, inbox: tabInbox, settings: tabSettings }[tab]();
  return h('div', {}, noticeBanner(), nav, h('section', { class: 'vw-panel', role: 'tabpanel' }, body));
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
  if (filters.role) evs = evs.filter((e) => e.body.role === filters.role);
  if (filters.contact) evs = evs.filter((e) => involves(e, wallet.get(filters.contact) || { rootId: filters.contact, body: {} }));
  const as = assessments();
  const due = as.filter((a) => a.body.checkAfter && a.body.checkAfter <= today() && !as.some((b) => b.body.eventId === a.body.eventId && b.firstAt > a.firstAt));
  const out = [
    h('div', { class: 'vw-toolbar' },
      h('button', { class: 'vw-btn vw-primary', onclick: () => eventDialog() }, t('ev.add')),
      h('button', { class: 'vw-btn', onclick: registryDialog }, t('ev.fromRegistry'))),
    h('div', { class: 'vw-filters' },
      sel('system', systems().map((s) => [s.rootId, s.body.title])),
      sel('role', ['actor', 'affected', 'user', 'witness'].map((r) => [r, t('role.' + r)])),
      sel('contact', contacts().filter((c) => c.body.type !== 'self').map((c) => [c.rootId, c.body.name]))),
  ];
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
  return h('article', { class: 'vw-card' },
    h('div', { class: 'vw-row' }, h('h3', {}, phrase(ev)),
      h('span', { class: 'vw-chips' }, h('span', { class: 'vw-chip' }, t('role.' + b.role)), b.systemId ? h('span', { class: 'vw-chip vw-chip-sys' }, sysTitle(b.systemId)) : null,
        b.registryRef ? h('span', { class: 'vw-chip' }, t('ev.fromReg')) : null,
        b.receiptState ? h('span', { class: 'vw-chip' + (b.receiptState === 'matched' ? ' vw-chip-sys' : '') }, t('rc.state.' + b.receiptState) + ((b.stamps || []).length ? ' · ' + t('rc.stamped') : '')) : null)),
    h('div', { class: 'vw-phases' },
      h('div', { class: 'vw-phase' }, h('div', { class: 'vw-muted' }, t('phase.plan')),
        plans.length ? plans.map((p) => h('div', { class: 'vw-plan' }, `${p.body.author === selfId() ? t('plan.mine') : nameOf(p.body.author)}: ${p.body.promise}`,
          h('div', { class: 'vw-muted vw-small' }, t('plan.counted', { f: pct(V.planFactor(s, { contactId: p.body.author, systemId: b.systemId })) })))) : h('span', { class: 'vw-muted' }, '-')),
      h('div', { class: 'vw-phase' }, h('div', { class: 'vw-muted' }, t('phase.realized')), realized ? assessmentView(realized) : h('span', { class: 'vw-muted' }, '-')),
      h('div', { class: 'vw-phase' }, h('div', { class: 'vw-muted' }, t('phase.retro')), retro ? assessmentView(retro) : h('span', { class: 'vw-muted' }, realized ? '-' : t('phase.retroAfter')))),
    eff !== null ? h('p', { class: 'vw-muted vw-small' }, t('ev.efficiency', { e: num(eff), net: pct(latest.body.v - latest.body.spentV) })) : null,
    h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn', onclick: () => assessDialog(ev.rootId, null, { phase: realized ? 'retro' : 'realized' }) }, t(realized ? 'ev.assessLater' : 'ev.assess')),
      h('button', { class: 'vw-btn', onclick: () => planDialog(ev.rootId) }, t('ev.plan')),
      latest && target ? h('button', { class: 'vw-btn', onclick: () => shareDialog(ev, latest, target) }, t('ev.share', { name: nameOf(target) })) : null,
      !b.receiptState && receiptTarget(ev) ? h('button', { class: 'vw-btn', onclick: () => confirmDialog(ev, receiptTarget(ev)) }, t('rc.btn')) : null,
      b.receiptState === 'matched' && !(b.stamps || []).length ? h('button', { class: 'vw-btn vw-ghost', onclick: async () => {
        const st = await guard(() => wallet.stampAt(ev.rootId, (wallet.settings().arbiters || [])[0]?.url || AEVRI_ARBITER));
        if (st) { toast(t('rc.stampDone', { at: st.receivedAt.replace('T', ' ').slice(0, 16) })); render(); }
      } }, t('rc.stamp')) : null,
      h('button', { class: 'vw-btn vw-ghost', onclick: () => eventDialog(ev) }, t('edit')),
      itemMenu(ev)));
}

function assessmentView(a) {
  const b = a.body;
  return h('div', { class: 'vw-assess' },
    typeof b.v === 'number' && (b.contributions || []).length ? h('div', { class: b.v < 0 ? 'vw-v vw-neg' : 'vw-v' }, t(b.v < 0 ? 'val.short.harm' : 'val.short', { v: pct(Math.abs(b.v)) })) : null,
    b.spentV > 0 ? h('div', { class: 'vw-muted vw-small' }, t('val.spentShort', { v: pct(b.spentV) })) : null,
    b.ownScore ? h('div', { class: 'vw-muted vw-small' }, t('as.ownShow', { v: b.ownScore.value.toLocaleString(lang), u: b.ownScore.unit || '' })) : null,
    b.reference ? h('div', { class: 'vw-chip' }, t('as.isReference')) : null,
    (b.gained || []).map((x) => h('div', { class: 'vw-gained' }, '+ ' + x)),
    (b.lost || []).map((x) => h('div', { class: 'vw-lost' }, '- ' + x)),
    h('button', { class: 'vw-link', onclick: () => assessDialog(b.eventId, a) }, t('edit')));
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

async function registryDialog() {
  const doc = await pickFile();
  if (!doc) return;
  const reg = doc.registry;
  if (!reg || reg.type !== 'aevri.vledger.registry') { toast(t('reg.bad')); return; }
  const ok = await C.verify(C.keyOfAddress(reg.owner.card.address), C.te.encode(C.canon(reg)), doc.sig) && await C.verifyCard(reg.owner);
  if (!ok) { toast(t('reg.badSig')); return; }
  await modal(t('reg.title', { name: reg.owner.card.name || short(reg.owner.card.address) }), (close) => h('div', {},
    h('p', { class: 'vw-hint' }, t('reg.hint')),
    reg.items.map((it) => h('div', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('strong', {}, it.title), h('span', { class: 'vw-chip' }, t('reg.kind.' + it.kind))),
      it.plan ? h('p', { class: 'vw-plan' }, t('reg.promise', { p: it.plan.promise })) : null,
      it.affects ? h('p', { class: 'vw-muted' }, it.affects) : null,
      h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', onclick: async () => { close(true); await addFromRegistry(doc, it); } }, t(it.kind === 'object' ? 'reg.use' : 'reg.affected')))))));
}

async function addFromRegistry(doc, it) {
  const reg = doc.registry;
  const owner = await guard(() => wallet.addCard(reg.owner));
  if (!owner) return;
  if (!wallet.list('import').some((i) => i.body.originId === reg.registryUrl)) {
    await wallet.add('import', { origin: 'file', originId: reg.registryUrl, payload: doc, payloadHash: await C.hashJson(doc) }, { source: 'registry' });
  }
  const rs = reg.systems.find((s) => s.systemId === it.system);
  let sys = systems().find((s) => s.body.registryUrl === reg.registryUrl);
  const sysId = sys ? sys.rootId : await wallet.add('value-system', { title: rs?.title || it.system, W: 1, status: 'active', registryUrl: reg.registryUrl, note: t('reg.sysNote') });
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
    const gained = h('textarea', { rows: 2, placeholder: t('as.linesPh') }, (b.gained || []).join('\n'));
    const lost = h('textarea', { rows: 2, placeholder: t('as.linesPh') }, (b.lost || []).join('\n'));
    const preview = h('p', { class: 'vw-preview', 'aria-live': 'polite' });
    const refresh = () => {
      const r = valueOf(contribs.read(), spent.read());
      preview.textContent = valueWords(r, ev.body.systemId, evRootId);
    };
    const contribs = contribRows(b.contributions || [], refresh, sysGoal);
    const spent = contribRows(b.spent || [], refresh, undefined);
    if (!(b.contributions || []).length && goalOptions().length) contribs.add();
    const own = h('input', { type: 'number', step: 'any', value: b.ownScore?.value ?? '' });
    const ownU = h('input', { type: 'text', maxlength: 40, placeholder: t('as.unitPh'), value: b.ownScore?.unit || '' });
    const conf = select(['low', 'medium', 'high'].map((k) => [k, t('conf.' + k)]), b.confidence);
    const reasons = h('textarea', { rows: 2, maxlength: 2000 }, b.reasons || '');
    const check = h('input', { type: 'date', value: b.checkAfter || '' });
    const isRef = h('input', { type: 'checkbox', checked: !!b.reference });
    const planCount = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: b.planCount ?? V.planFactor(wallet.settings(), { contactId: ev.body.actor, systemId: ev.body.systemId }) });
    const planOut = h('output', {}, pct(Number(planCount.value)));
    planCount.addEventListener('input', () => { planOut.textContent = pct(Number(planCount.value)); });
    refresh();
    return h('div', { class: 'vw-assess-layout' },
      orientation(ev.body.systemId, evRootId),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        const c = contribs.read(), sp = spent.read();
        const r = valueOf(c, sp);
        const body = { eventId: evRootId, phase: phaseSel.value, gained: lines(gained.value), lost: lines(lost.value), contributions: c, spent: sp, reference: isRef.checked, confidence: conf.value };
        if (c.length) body.v = r.v;
        if (sp.length) body.spentV = r.spentV;
        if (own.value !== '') body.ownScore = { value: Number(own.value), ...(ownU.value.trim() ? { unit: ownU.value.trim() } : {}) };
        if (reasons.value.trim()) body.reasons = reasons.value.trim();
        if (check.value) body.checkAfter = check.value;
        if (hasPlan) body.planCount = Number(planCount.value);
        const id = await guard(() => (existing ? wallet.correct(existing.rootId, body) : wallet.add('assessment', body)));
        close(true); render();
        if (id && c.length) feelingCheck(evRootId, wallet.rootOf(id), body, r);
      } },
      field(t('as.phase'), phaseSel, canRetro ? null : t('as.retroHint')),
      field(t('as.gained'), gained, t('as.linesHint')), field(t('as.lost'), lost),
      h('fieldset', {}, h('legend', {}, t('as.goals')),
        goalOptions().length ? [contribs.node, h('button', { type: 'button', class: 'vw-link', onclick: () => { contribs.add(); refresh(); } }, t('as.addGoal'))] : h('p', { class: 'vw-hint' }, t('as.noGoals'))),
      h('fieldset', {}, h('legend', {}, t('as.spent')), h('p', { class: 'vw-hint' }, t('as.spentHint')),
        spent.node, h('button', { type: 'button', class: 'vw-link', onclick: () => { spent.add(); refresh(); } }, t('as.addSpent'))),
      preview,
      h('div', { class: 'vw-inline' }, field(t('as.own'), own, t('as.ownHint')), field(t('as.unit'), ownU)),
      hasPlan ? field(t('as.planCount'), h('div', { class: 'vw-inline' }, planCount, planOut), t('as.planCountHint')) : null,
      h('div', { class: 'vw-inline' }, field(t('as.conf'), conf), field(t('as.check'), check, t('as.checkHint'))),
      field(t('as.reasons'), reasons),
      h('label', { class: 'vw-check' }, isRef, h('span', {}, t('as.reference'))),
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
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!title.value.trim()) { msg.textContent = t('sys.needTitle'); return; }
      if (!(Number(W.value) > 0)) { msg.textContent = t('sys.needW'); return; }
      const body = { ...(s ? s.body : {}), title: title.value.trim(), W: Number(W.value), status: status.value };
      if (note.value.trim()) body.note = note.value.trim(); else delete body.note;
      await guard(() => (s ? wallet.correct(s.rootId, body) : wallet.add('value-system', body)));
      close(true); render();
    } }, field(t('sys.title'), title), field(t('sys.W'), W, t('sys.WHint')), field(t('goal.status'), status), field(t('cp.note'), note), msg, submitRow());
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
  return [
    relaySection(),
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
    h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn', onclick: async () => { const p = await wallet.verify(); toast(p.length ? t('set.chainBad', { n: p.length }) : t('set.chainOk')); } }, t('set.verify')),
      h('button', { class: 'vw-btn', onclick: passDialog }, t('set.changePass')),
      h('button', { class: 'vw-btn', onclick: lockNow }, t('lock'))),
    h('h2', {}, t('set.danger')),
    h('button', { class: 'vw-btn vw-danger', onclick: async () => {
      if (!confirm(t('set.removeConfirm'))) return;
      await guard(() => device.remove(wallet.id)); lockNow(); toast(t('set.removed'));
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
}

export async function start() {
  let saved = null;
  try { saved = localStorage.getItem('vledger.lang'); } catch { /* ignore */ }
  const siteLang = document.querySelector('meta[name="aevri-lang"]')?.content; // set by the institute page for /xx/ addresses
  await loadLang(saved || (LANGS.includes(siteLang) ? siteLang : null) || (navigator.language || 'en').slice(0, 2));
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  await render();
}

export const _test = { get wallet() { return wallet; }, render };
