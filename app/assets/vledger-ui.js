// Value Wallet L1 UI. Plain DOM, no framework. Talks only to vledger-store.js and vledger-value.js.

import { Wallet, device, passphraseOk, inspectImport } from './vledger-store.js';
import * as V from './vledger-value.js';
import { nowIso } from './vledger-crypto.js';

const LANGS = ['en', 'ru'];
let L = {};
let lang = 'en';
let wallet = null;
let tab = 'exchanges';
let idleTimer = null;
const IDLE_MS = 15 * 60 * 1000;

// ---- i18n ----

function t(key, vars = {}) {
  let s = L[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', v);
  return s;
}

async function loadLang(code) {
  lang = LANGS.includes(code) ? code : 'en';
  const base = new URL('./locales/', import.meta.url);
  L = await (await fetch(new URL(lang + '.json', base))).json();
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
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const $app = () => document.getElementById('app');
const fmtPct = (x) => (Math.round(x * 1000) / 10).toLocaleString(lang) + '%';
const today = () => new Date().toISOString().slice(0, 10);
const lines = (s) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 300));

function toast(msg) {
  const el = h('div', { class: 'vw-toast', role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// Modal dialog. build(close) returns content; resolves with the value passed to close().
function modal(title, build) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'vw-dialog', 'aria-label': title });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(h('div', { class: 'vw-dialog-head' }, h('h2', {}, title), h('button', { class: 'vw-icon', type: 'button', 'aria-label': t('close'), onclick: () => close(null) }, '×')), build(close));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, textarea, select');
    if (first) first.focus();
  });
}

function field(label, input, hint) {
  return h('label', { class: 'vw-field' }, h('span', { class: 'vw-label' }, label), input, hint ? h('span', { class: 'vw-hint' }, hint) : null);
}

function select(options, value) {
  return h('select', {}, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

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
  render();
}

// ---- start screen ----

async function renderStart() {
  const list = await guard(() => device.list()) || [];
  const box = h('div', { class: 'vw-start' },
    h('p', { class: 'vw-lead' }, t('start.lead')),
    h('ul', { class: 'vw-facts' }, h('li', {}, t('start.f1')), h('li', {}, t('start.f2')), h('li', {}, t('start.f3'))),
  );
  if (list.length) {
    box.append(h('h2', {}, t('start.onDevice')));
    for (const w of list) {
      box.append(h('div', { class: 'vw-card vw-row' },
        h('div', {}, h('strong', {}, w.label || t('start.unnamed')), h('div', { class: 'vw-muted' }, t('start.records', { n: w.records, date: w.createdAt.slice(0, 10) }))),
        h('button', { class: 'vw-btn', onclick: () => unlockDialog(w.walletId, w.label) }, t('start.open'))));
    }
  }
  box.append(h('div', { class: 'vw-actions' },
    h('button', { class: 'vw-btn vw-primary', onclick: createDialog }, t('start.create')),
    h('button', { class: 'vw-btn', onclick: importDialog }, t('start.import'))));
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
        const d = doc || await device.get(walletId);
        wallet = await Wallet.unlock(d, pass.value);
        pass.value = '';
        close(true); touch(); render();
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
      if (wallet) { close(true); touch(); tab = 'exchanges'; render(); } else btn.disabled = false;
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
  const ins = await inspectImport(doc);
  if (!ins.ok) { toast(t('import.bad')); return; }
  if (ins.chain.length) toast(t('import.chain', { n: ins.chain.length }));
  const existing = await device.get(doc.walletId);
  if (existing) {
    // Same wallet already here: unlock the local copy and merge.
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

// ---- value words (SPEC 7 feeling check) ----

function goalsForValue() {
  return wallet.list('goal').map((g) => ({ id: g.rootId, S: g.body.S, N: g.body.N ?? g.body.S, status: g.body.status, title: g.body.title, unit: g.body.unit || '' }));
}

function valueSentence(contributions) {
  const goals = goalsForValue();
  const { v, parts } = V.comparableValue(goals, contributions);
  if (!parts.length) return { v, text: t('val.none') };
  const byId = Object.fromEntries(goals.map((g) => [g.id, g]));
  const main = parts.reduce((m, p) => (Math.abs(p.wk) > Math.abs(m.wk) ? p : m));
  const g = byId[main.goalId];
  const text = (v < 0 ? t('val.harm', { k: fmtPct(-main.k), goal: g.title, w: fmtPct(main.w), v: fmtPct(-v) }) : t('val.moved', { k: fmtPct(main.k), goal: g.title, w: fmtPct(main.w), v: fmtPct(v) }));
  return { v, text };
}

function rankWords(v) {
  const since = Date.now() - 30 * 86400000;
  const recent = currentAssessments().filter((a) => Date.parse(a.createdAt) >= since && typeof a.body.v === 'number');
  const better = recent.filter((a) => a.body.v > v).length;
  if (recent.length < 3) return '';
  if (better < 3) return t('val.top3');
  return t('val.rank', { n: better + 1, of: recent.length });
}

function currentAssessments() { return wallet.list('assessment'); }

// ---- tabs ----

const TABS = ['exchanges', 'counterparties', 'goals', 'facts', 'settings'];

function renderWallet() {
  const nav = h('nav', { class: 'vw-tabs', role: 'tablist' }, TABS.map((k) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'is-on' : '', onclick: () => { tab = k; render(); } }, t('tab.' + k))));
  const body = { exchanges: tabExchanges, counterparties: tabCounterparties, goals: tabGoals, facts: tabFacts, settings: tabSettings }[tab]();
  return h('div', {}, nav, h('section', { class: 'vw-panel', role: 'tabpanel' }, body));
}

function cpName(rootId) {
  const c = wallet.get(rootId);
  return c ? c.body.name : t('cp.unknown');
}

function typeName(rootId) {
  const x = rootId && wallet.get(rootId);
  return x ? x.body.name : '';
}

function elementLine(el) {
  const q = el.quantity != null ? ` (${el.quantity}${el.unit ? ' ' + el.unit : ''})` : '';
  const ty = typeName(el.typeId);
  return el.label + q + (ty ? ' · ' + ty : '');
}

// Exchanges

function tabExchanges() {
  const exs = wallet.list('exchange').sort((a, b) => String(b.body.occurredAt).localeCompare(String(a.body.occurredAt)));
  const assess = currentAssessments();
  const plans = wallet.list('plan');
  const settings = wallet.settings();
  const out = [h('div', { class: 'vw-toolbar' }, h('button', { class: 'vw-btn vw-primary', onclick: () => exchangeDialog() }, t('ex.add')))];

  const due = assess.filter((a) => a.body.checkAfter && a.body.checkAfter <= today() && !assess.some((b) => b.body.exchangeId === a.body.exchangeId && b.firstAt > a.firstAt));
  if (due.length) {
    out.push(h('div', { class: 'vw-card vw-due' }, h('strong', {}, t('ex.due')),
      due.map((a) => h('div', { class: 'vw-row' }, h('span', {}, exTitle(wallet.get(a.body.exchangeId))),
        h('button', { class: 'vw-btn', onclick: () => assessDialog(a.body.exchangeId, null, { phase: 'retro', elementRef: a.body.elementRef }) }, t('ex.compare'))))));
  }
  if (!exs.length) out.push(h('p', { class: 'vw-empty' }, t('ex.empty')));
  for (const ex of exs) {
    const b = ex.body;
    const myAss = assess.filter((a) => a.body.exchangeId === ex.rootId).sort((x, y) => x.firstAt.localeCompare(y.firstAt));
    const myPlans = plans.filter((p) => p.body.exchangeId === ex.rootId);
    out.push(h('article', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('h3', {}, exTitle(ex)), h('span', { class: 'vw-chip' }, t('status.' + b.status))),
      b.received.length ? h('p', {}, h('span', { class: 'vw-muted' }, t('ex.received') + ': '), b.received.map(elementLine).join('; ')) : null,
      b.given.length ? h('p', {}, h('span', { class: 'vw-muted' }, t('ex.given') + ': '), b.given.map(elementLine).join('; ')) : null,
      myPlans.map((p) => h('p', { class: 'vw-plan' }, t('plan.line', { who: cpName(p.body.authorCounterpartyId), promise: p.body.promise }), ' ',
        h('span', { class: 'vw-muted' }, t('plan.counted', { f: fmtPct(V.planFactor(settings, { counterpartyId: p.body.authorCounterpartyId })) })))),
      myAss.length ? h('div', { class: 'vw-phases' }, ['expected', 'received', 'retro'].map((ph) => {
        const a = myAss.filter((x) => x.body.phase === ph).pop();
        return h('div', { class: 'vw-phase' }, h('div', { class: 'vw-muted' }, t('phase.' + ph)), a ? assessmentView(a) : h('span', { class: 'vw-muted' }, '-'));
      })) : null,
      h('div', { class: 'vw-actions' },
        h('button', { class: 'vw-btn', onclick: () => assessDialog(ex.rootId) }, t('ex.assess')),
        h('button', { class: 'vw-btn', onclick: () => planDialog(ex.rootId) }, t('ex.plan')),
        h('button', { class: 'vw-btn vw-ghost', onclick: () => exchangeDialog(ex) }, t('edit')),
        itemMenu(ex))));
  }
  return out;
}

function exTitle(ex) {
  if (!ex) return '';
  return `${cpName(ex.body.counterpartyId)} · ${String(ex.body.occurredAt).slice(0, 10)}${ex.body.approx ? ' ~' : ''}`;
}

function assessmentView(a) {
  const b = a.body;
  return h('div', { class: 'vw-assess' },
    typeof b.v === 'number' && (b.contributions || []).length ? h('div', { class: b.v < 0 ? 'vw-v vw-neg' : 'vw-v' }, t(b.v < 0 ? 'val.short.harm' : 'val.short', { v: fmtPct(Math.abs(b.v)) })) : null,
    b.ownScore ? h('div', { class: 'vw-muted' }, t('as.own', { v: b.ownScore.value.toLocaleString(lang), u: b.ownScore.unit || '' })) : null,
    (b.gained || []).map((x) => h('div', { class: 'vw-gained' }, '+ ' + x)),
    (b.lost || []).map((x) => h('div', { class: 'vw-lost' }, '- ' + x)),
    h('button', { class: 'vw-link', onclick: () => assessDialog(b.exchangeId, a) }, t('edit')));
}

function itemMenu(item, after) {
  return h('span', { class: 'vw-menu' },
    item.versions > 1 ? h('button', { class: 'vw-btn vw-ghost', onclick: () => historyDialog(item.rootId) }, t('history', { n: item.versions })) : null,
    h('button', { class: 'vw-btn vw-ghost', onclick: async () => { if (confirm(t('withdraw.confirm'))) { await guard(() => wallet.withdraw(item.rootId)); after && after(); render(); } } }, t('withdraw')),
    h('button', { class: 'vw-btn vw-ghost vw-danger', onclick: async () => { if (confirm(t('erase.confirm'))) { await guard(() => wallet.eraseItem(item.rootId)); toast(t('erase.done')); render(); } } }, t('erase')));
}

function historyDialog(rootId) {
  return modal(t('history.title'), () => h('ol', { class: 'vw-history' }, wallet.versions(rootId).map((v) =>
    h('li', {}, h('div', { class: 'vw-muted' }, v.payload ? v.payload.createdAt.replace('T', ' ').slice(0, 16) : t('erased')),
      v.payload ? h('pre', {}, JSON.stringify(v.payload.body, null, 1)) : null))));
}

function elementRows(list, types) {
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
  (list.length ? list : []).forEach(addRow);
  return { node: wrap, add: addRow, read: () => [...wrap.querySelectorAll('.vw-element')].map((r) => {
    const label = r.querySelector('.el-label').value.trim();
    if (!label) return null;
    const q = r.querySelector('.el-q').value;
    const o = { label };
    if (q !== '') o.quantity = Number(q);
    const u = r.querySelector('.el-u').value.trim(); if (u) o.unit = u;
    const ty = r.querySelector('select').value; if (ty) o.typeId = ty;
    return o;
  }).filter(Boolean) };
}

function exchangeDialog(ex) {
  const b = ex ? ex.body : { given: [], received: [], occurredAt: today(), status: 'recorded' };
  return modal(t(ex ? 'ex.editTitle' : 'ex.addTitle'), (close) => {
    const cps = wallet.list('counterparty');
    const types = wallet.list('element-type');
    const cp = select([...cps.map((c) => [c.rootId, `${c.body.name} (${t('cpt.' + c.body.type)})`]), ['__new', t('cp.new')]], b.counterpartyId || (cps.find((c) => c.body.type !== 'self') || cps[0])?.rootId);
    const newType = select(['person', 'organization', 'state', 'group', 'unknown'].map((k) => [k, t('cpt.' + k)]), 'person');
    const newName = h('input', { type: 'text', maxlength: 300 });
    const newBox = h('div', { class: 'vw-inline', hidden: cp.value !== '__new' }, newType, newName);
    cp.addEventListener('change', () => { newBox.hidden = cp.value !== '__new'; });
    const date = h('input', { type: 'date', value: String(b.occurredAt).slice(0, 10) });
    const approx = h('input', { type: 'checkbox', checked: !!b.approx });
    const rec = elementRows(b.received, types);
    const giv = elementRows(b.given, types);
    if (!ex) rec.add();
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      let cpId = cp.value;
      const received = rec.read(), given = giv.read();
      if (!received.length && !given.length) { msg.textContent = t('ex.needOne'); return; }
      if (cpId === '__new') {
        if (!newName.value.trim()) { msg.textContent = t('cp.needName'); return; }
        cpId = await wallet.add('counterparty', { type: newType.value, name: newName.value.trim() });
      }
      const body = { counterpartyId: cpId, given, received, occurredAt: date.value || today(), status: b.status || 'recorded' };
      if (approx.checked) body.approx = true;
      await guard(() => (ex ? wallet.correct(ex.rootId, body) : wallet.add('exchange', body)));
      close(true); render();
    } },
    field(t('ex.with'), cp), newBox,
    h('div', { class: 'vw-inline' }, field(t('ex.when'), date), h('label', { class: 'vw-check' }, approx, h('span', {}, t('ex.approx')))),
    h('fieldset', {}, h('legend', {}, t('ex.received')), rec.node),
    h('fieldset', {}, h('legend', {}, t('ex.given')), giv.node),
    msg, h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
  });
}

function planDialog(exRootId, plan) {
  const ex = wallet.get(exRootId);
  const p = plan ? plan.body : {};
  return modal(t('plan.title'), (close) => {
    const opts = elementOptions(ex);
    const el = select(opts.map((o) => [o.key, o.label]), p.elementRef ? refKey(p.elementRef) : opts[0]?.key);
    const promise = h('textarea', { rows: 3, maxlength: 2000 }, p.promise || '');
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!promise.value.trim()) { msg.textContent = t('plan.need'); return; }
      const body = { exchangeId: exRootId, elementRef: keyRef(exRootId, el.value), authorCounterpartyId: ex.body.counterpartyId, promise: promise.value.trim() };
      await guard(() => (plan ? wallet.correct(plan.rootId, body) : wallet.add('plan', body)));
      close(true); render();
    } },
    h('p', { class: 'vw-hint' }, t('plan.hint', { who: cpName(ex.body.counterpartyId) })),
    field(t('plan.element'), el), field(t('plan.promise'), promise), msg,
    h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
  });
}

function elementOptions(ex) {
  return [...ex.body.received.map((e, i) => ({ key: 'received:' + i, label: t('ex.received') + ': ' + e.label })),
    ...ex.body.given.map((e, i) => ({ key: 'given:' + i, label: t('ex.given') + ': ' + e.label }))];
}
const refKey = (r) => `${r.side}:${r.index}`;
const keyRef = (exId, k) => { const [side, index] = k.split(':'); return { exchangeId: exId, side, index: Number(index) }; };

function assessDialog(exRootId, existing, preset = {}) {
  const ex = wallet.get(exRootId);
  if (!ex) return null;
  const b = existing ? existing.body : { phase: preset.phase || 'received', confidence: 'medium', contributions: [], elementRef: preset.elementRef };
  const goals = wallet.list('goal').filter((g) => g.body.status === 'active');
  const hasPlan = wallet.list('plan').some((p) => p.body.exchangeId === exRootId);
  return modal(t('as.title', { ex: exTitle(ex) }), (close) => {
    const opts = elementOptions(ex);
    const el = select(opts.map((o) => [o.key, o.label]), b.elementRef ? refKey(b.elementRef) : opts[0]?.key);
    const phase = select(['expected', 'received', 'retro'].map((k) => [k, t('phase.' + k)]), b.phase);
    const gained = h('textarea', { rows: 2, placeholder: t('as.gainedPh') }, (b.gained || []).join('\n'));
    const lost = h('textarea', { rows: 2, placeholder: t('as.lostPh') }, (b.lost || []).join('\n'));
    const own = h('input', { type: 'number', step: 'any', value: b.ownScore?.value ?? '' });
    const ownU = h('input', { type: 'text', maxlength: 40, placeholder: t('as.unitPh'), value: b.ownScore?.unit || '' });
    const conf = select(['low', 'medium', 'high'].map((k) => [k, t('conf.' + k)]), b.confidence);
    const reasons = h('textarea', { rows: 2, maxlength: 2000 }, b.reasons || '');
    const check = h('input', { type: 'date', value: b.checkAfter || '' });
    const planCount = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: b.planCount ?? V.planFactor(wallet.settings(), { counterpartyId: ex.body.counterpartyId }) });
    const planOut = h('output', {}, fmtPct(Number(planCount.value)));
    planCount.addEventListener('input', () => { planOut.textContent = fmtPct(Number(planCount.value)); });
    const preview = h('p', { class: 'vw-preview', 'aria-live': 'polite' });
    const contribBox = h('div', { class: 'vw-contribs' });
    const readContribs = () => [...contribBox.querySelectorAll('.vw-contrib')].map((r) => {
      const goalId = r.querySelector('select').value;
      const amount = r.querySelector('input').value;
      const mode = r.querySelector('.c-mode').value;
      if (!goalId || amount === '') return null;
      return mode === 'pct' ? { goalId, k: Number(amount) / 100 } : { goalId, c: Number(amount) };
    }).filter(Boolean);
    const refresh = () => { preview.textContent = valueSentence(readContribs()).text; };
    const addContrib = (c = {}) => {
      const g = select(goals.map((x) => [x.rootId, x.body.title]), c.goalId);
      const mode = select([['amount', t('as.inUnits')], ['pct', t('as.inPct')]], 'k' in c ? 'pct' : 'amount');
      mode.classList.add('c-mode');
      const amt = h('input', { type: 'number', step: 'any', value: 'k' in c ? c.k * 100 : (c.c ?? ''), 'aria-label': t('as.amount') });
      const row = h('div', { class: 'vw-contrib' }, g, amt, mode, h('button', { type: 'button', class: 'vw-icon', 'aria-label': t('remove'), onclick: () => { row.remove(); refresh(); } }, '×'));
      [g, amt, mode].forEach((x) => x.addEventListener('input', refresh));
      contribBox.append(row);
    };
    (b.contributions || []).forEach(addContrib);
    if (!(b.contributions || []).length && goals.length) addContrib();
    refresh();
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const contributions = readContribs();
      const { v } = V.comparableValue(goalsForValue(), contributions);
      const body = { exchangeId: exRootId, elementRef: el.value ? keyRef(exRootId, el.value) : undefined, phase: phase.value, gained: lines(gained.value), lost: lines(lost.value), contributions, confidence: conf.value };
      if (contributions.length) body.v = v;
      if (own.value !== '') body.ownScore = { value: Number(own.value), ...(ownU.value.trim() ? { unit: ownU.value.trim() } : {}) };
      if (reasons.value.trim()) body.reasons = reasons.value.trim();
      if (check.value) body.checkAfter = check.value;
      if (hasPlan) body.planCount = Number(planCount.value);
      if (!body.elementRef) delete body.elementRef;
      const id = await guard(() => (existing ? wallet.correct(existing.rootId, body) : wallet.add('assessment', body)));
      close(true); render();
      if (id && contributions.length) feelingCheck(exRootId, wallet.rootOf(id), body);
    } },
    h('div', { class: 'vw-inline' }, field(t('as.element'), el), field(t('as.phase'), phase)),
    field(t('as.gained'), gained, t('as.linesHint')), field(t('as.lost'), lost),
    h('fieldset', {}, h('legend', {}, t('as.goals')),
      goals.length ? [contribBox, h('button', { type: 'button', class: 'vw-link', onclick: () => { addContrib(); refresh(); } }, t('as.addGoal'))] : h('p', { class: 'vw-hint' }, t('as.noGoals')),
      preview),
    h('div', { class: 'vw-inline' }, field(t('as.own'), own, t('as.ownHint')), field(t('as.unit'), ownU)),
    hasPlan ? field(t('as.planCount'), h('div', { class: 'vw-inline' }, planCount, planOut), t('as.planCountHint')) : null,
    h('div', { class: 'vw-inline' }, field(t('as.conf'), conf), field(t('as.check'), check, t('as.checkHint'))),
    field(t('as.reasons'), reasons),
    h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
  });
}

async function feelingCheck(exRootId, assessRoot, body) {
  const { text } = valueSentence(body.contributions);
  const rank = body.v > 0 ? rankWords(body.v) : '';
  const goals = goalsForValue();
  const hist = currentAssessments().map((a) => ({ at: a.createdAt, v: a.body.v, ownScore: a.body.ownScore, contributions: a.body.contributions || [] }));
  const flags = V.feelingChecks(goals, hist);
  const ans = await modal(t('fc.title'), (close) => h('div', {},
    h('p', { class: 'vw-lead' }, text + (rank ? ' ' + rank : '')),
    h('p', {}, t('fc.q')),
    flags.map((f) => h('p', { class: 'vw-flag' }, t('flag.' + f.code, { goal: goals.find((g) => g.id === f.goalId)?.title || '' }))),
    h('div', { class: 'vw-actions' },
      h('button', { class: 'vw-btn vw-primary', onclick: () => close('yes') }, t('fc.yes')),
      h('button', { class: 'vw-btn', onclick: () => close('less') }, t('fc.less')),
      h('button', { class: 'vw-btn', onclick: () => close('more') }, t('fc.more')))));
  if (ans === 'less' || ans === 'more') {
    toast(t(ans === 'less' ? 'fc.lessHint' : 'fc.moreHint'));
    assessDialog(exRootId, wallet.get(assessRoot) && { ...wallet.get(assessRoot), rootId: assessRoot });
  }
}

// Counterparties

function tabCounterparties() {
  const cps = wallet.list('counterparty').filter((c) => c.body.type !== 'self');
  const exs = wallet.list('exchange');
  const out = [h('div', { class: 'vw-toolbar' }, h('button', { class: 'vw-btn vw-primary', onclick: () => cpDialog() }, t('cp.add')))];
  if (!cps.length) out.push(h('p', { class: 'vw-empty' }, t('cp.empty')));
  for (const type of ['person', 'organization', 'state', 'group', 'unknown']) {
    const group = cps.filter((c) => c.body.type === type);
    if (!group.length) continue;
    out.push(h('h2', {}, t('cpt.' + type + '.many')));
    for (const c of group) {
      const n = exs.filter((x) => x.body.counterpartyId === c.rootId).length;
      out.push(h('article', { class: 'vw-card' }, h('div', { class: 'vw-row' }, h('h3', {}, c.body.name), h('span', { class: 'vw-muted' }, t('cp.exchanges', { n }))),
        c.body.note ? h('p', {}, c.body.note) : null,
        c.body.profileUrl ? h('p', { class: 'vw-muted' }, c.body.profileUrl) : null,
        h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-ghost', onclick: () => cpDialog(c) }, t('edit')), itemMenu(c))));
    }
  }
  return out;
}

function cpDialog(c) {
  const b = c ? c.body : { type: 'person' };
  return modal(t(c ? 'cp.editTitle' : 'cp.addTitle'), (close) => {
    const type = select(['person', 'organization', 'state', 'group', 'unknown'].map((k) => [k, t('cpt.' + k)]), b.type);
    const name = h('input', { type: 'text', maxlength: 300, value: b.name || '' });
    const note = h('textarea', { rows: 2, maxlength: 2000 }, b.note || '');
    const url = h('input', { type: 'url', placeholder: 'https://', value: b.profileUrl || '' });
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { msg.textContent = t('cp.needName'); return; }
      if (url.value && !/^https:\/\//.test(url.value)) { msg.textContent = t('cp.badUrl'); return; }
      const body = { type: type.value, name: name.value.trim() };
      if (note.value.trim()) body.note = note.value.trim();
      if (url.value) body.profileUrl = url.value;
      await guard(() => (c ? wallet.correct(c.rootId, body) : wallet.add('counterparty', body)));
      close(true); render();
    } }, field(t('cp.type'), type), field(t('cp.name'), name), field(t('cp.note'), note), field(t('cp.url'), url, t('cp.urlHint')), msg,
    h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
  });
}

// Goals

function tabGoals() {
  const goals = wallet.list('goal');
  const w = V.goalWeights(goalsForValue());
  const assess = currentAssessments();
  const out = [h('div', { class: 'vw-toolbar' }, h('button', { class: 'vw-btn vw-primary', onclick: () => goalDialog() }, t('goal.add')))];
  out.push(h('p', { class: 'vw-hint' }, t('goal.lead')));
  if (!goals.length) out.push(h('p', { class: 'vw-empty' }, t('goal.empty')));
  for (const g of goals.sort((a, b) => b.body.S - a.body.S)) {
    const N = g.body.N ?? g.body.S;
    const k = assess.flatMap((a) => (a.body.contributions || []).filter((c) => c.goalId === g.rootId)).reduce((s, c) => s + V.progressShare({ S: g.body.S, N }, c), 0);
    out.push(h('article', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('h3', {}, g.body.title), h('span', { class: 'vw-chip' }, t('gs.' + g.body.status))),
      g.body.why ? h('p', {}, g.body.why) : null,
      h('p', { class: 'vw-muted' }, t('goal.numbers', { s: g.body.S.toLocaleString(lang) + (g.body.unit ? ' ' + g.body.unit : ''), n: N.toLocaleString(lang) + (g.body.unit ? ' ' + g.body.unit : ''), w: g.rootId in w ? fmtPct(w[g.rootId]) : '-' })),
      h('div', { class: 'vw-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(Math.max(0, Math.min(1, k)) * 100), 'aria-label': t('goal.progress') },
        h('span', { style: `width:${Math.max(0, Math.min(1, k)) * 100}%` })),
      h('p', { class: 'vw-muted' }, t('goal.progressText', { k: fmtPct(k) })),
      h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-ghost', onclick: () => goalDialog(g) }, t('edit')), itemMenu(g))));
  }
  return out;
}

function goalDialog(g) {
  const b = g ? g.body : { status: 'active' };
  return modal(t(g ? 'goal.editTitle' : 'goal.addTitle'), (close) => {
    const title = h('input', { type: 'text', maxlength: 300, value: b.title || '' });
    const why = h('textarea', { rows: 2, maxlength: 2000 }, b.why || '');
    const signs = h('textarea', { rows: 2, maxlength: 2000 }, b.signs || '');
    const horizon = h('input', { type: 'text', maxlength: 100, value: b.horizon || '' });
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
      if (N.value !== '') body.N = Number(N.value);
      for (const [k, el] of [['why', why], ['signs', signs], ['horizon', horizon], ['unit', unit]]) if (el.value.trim()) body[k] = el.value.trim();
      await guard(() => (g ? wallet.correct(g.rootId, body) : wallet.add('goal', body)));
      close(true); render();
    } },
    field(t('goal.title'), title), field(t('goal.why'), why), field(t('goal.signs'), signs),
    h('div', { class: 'vw-inline' }, field(t('goal.S'), S, t('goal.SHint')), field(t('goal.N'), N, t('goal.NHint')), field(t('goal.unit'), unit)),
    h('div', { class: 'vw-inline' }, field(t('goal.horizon'), horizon), field(t('goal.status'), status)),
    msg, h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
  });
}

// Facts

function tabFacts() {
  const facts = wallet.list('fact').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const out = [h('div', { class: 'vw-toolbar' }, h('button', { class: 'vw-btn vw-primary', onclick: () => factDialog() }, t('fact.add')))];
  out.push(h('p', { class: 'vw-hint' }, t('fact.lead')));
  if (!facts.length) out.push(h('p', { class: 'vw-empty' }, t('fact.empty')));
  for (const f of facts) {
    const goals = (f.body.goalIds || []).map((id) => wallet.get(id)?.body.title).filter(Boolean);
    out.push(h('article', { class: 'vw-card' },
      h('div', { class: 'vw-row' }, h('span', { class: 'vw-muted' }, f.body.topic || ''), h('span', { class: 'vw-chip' }, t('conf.' + f.body.certainty) + (f.body.exploring ? ' · ' + t('fact.exploring') : ''))),
      h('p', {}, f.body.text),
      goals.length ? h('p', { class: 'vw-muted' }, t('fact.goals') + ': ' + goals.join(', ')) : null,
      h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-ghost', onclick: () => factDialog(f) }, t('fact.revise')), itemMenu(f))));
  }
  return out;
}

function factDialog(f) {
  const b = f ? f.body : { certainty: 'medium', exploring: false, goalIds: [] };
  return modal(t(f ? 'fact.editTitle' : 'fact.addTitle'), (close) => {
    const topic = h('input', { type: 'text', maxlength: 100, value: b.topic || '' });
    const text = h('textarea', { rows: 4, maxlength: 2000 }, b.text || '');
    const cert = select(['low', 'medium', 'high'].map((k) => [k, t('conf.' + k)]), b.certainty);
    const exploring = h('input', { type: 'checkbox', checked: !!b.exploring });
    const goals = wallet.list('goal');
    const boxes = goals.map((g) => h('label', { class: 'vw-check' }, h('input', { type: 'checkbox', value: g.rootId, checked: (b.goalIds || []).includes(g.rootId) }), h('span', {}, g.body.title)));
    const msg = h('p', { class: 'vw-error', role: 'alert' });
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!text.value.trim()) { msg.textContent = t('fact.need'); return; }
      const body = { text: text.value.trim(), certainty: cert.value, exploring: exploring.checked, goalIds: boxes.map((x) => x.querySelector('input')).filter((x) => x.checked).map((x) => x.value) };
      if (topic.value.trim()) body.topic = topic.value.trim();
      await guard(() => (f ? wallet.correct(f.rootId, body) : wallet.add('fact', body)));
      close(true); render();
    } },
    field(t('fact.topic'), topic), field(t('fact.text'), text),
    h('div', { class: 'vw-inline' }, field(t('fact.certainty'), cert), h('label', { class: 'vw-check' }, exploring, h('span', {}, t('fact.exploringLong')))),
    goals.length ? h('fieldset', {}, h('legend', {}, t('fact.goals')), boxes) : null,
    msg, h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
  });
}

// Settings

function tabSettings() {
  const s = wallet.settings();
  const cps = wallet.list('counterparty').filter((c) => c.body.type !== 'self');
  const types = wallet.list('element-type');
  const def = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.planCountDefault });
  const defOut = h('output', {}, fmtPct(s.planCountDefault));
  def.addEventListener('input', () => { defOut.textContent = fmtPct(Number(def.value)); });
  def.addEventListener('change', async () => { await guard(() => wallet.saveSettings({ ...wallet.settings(), planCountDefault: Number(def.value) })); toast(t('saved')); });
  const per = cps.map((c) => {
    const rule = (s.planCountBy || []).find((r) => r.counterpartyId === c.rootId && !r.typeId);
    const inp = h('input', { type: 'number', min: 0, max: 100, step: 5, value: rule ? Math.round(rule.factor * 100) : '', placeholder: t('set.inherit'), 'aria-label': c.body.name });
    inp.addEventListener('change', async () => {
      const cur = wallet.settings();
      const rules = (cur.planCountBy || []).filter((r) => !(r.counterpartyId === c.rootId && !r.typeId));
      if (inp.value !== '') rules.push({ counterpartyId: c.rootId, factor: Math.max(0, Math.min(100, Number(inp.value))) / 100 });
      await guard(() => wallet.saveSettings({ ...cur, planCountBy: rules })); toast(t('saved'));
    });
    return h('div', { class: 'vw-row' }, h('span', {}, c.body.name), h('span', { class: 'vw-inline' }, inp, '%'));
  });
  return [
    h('h2', {}, t('set.plan')), h('p', { class: 'vw-hint' }, t('set.planHint')),
    field(t('set.planDefault'), h('div', { class: 'vw-inline' }, def, defOut)),
    per.length ? h('details', {}, h('summary', {}, t('set.planPer')), per) : null,
    h('h2', {}, t('set.types')),
    types.map((x) => h('div', { class: 'vw-row' }, h('span', {}, `${x.body.name} · ${t('cat.' + x.body.category)}`), itemMenu(x))),
    h('button', { class: 'vw-btn', onclick: typeDialog }, t('set.addType')),
    h('h2', {}, t('set.storage')),
    h('p', { class: 'vw-hint' }, t('set.storageHint')),
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
    const cat = select(['thing', 'service', 'information', 'time', 'money', 'right', 'decision', 'relation', 'other'].map((k) => [k, t('cat.' + k)]), 'thing');
    return h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      await guard(() => wallet.add('element-type', { name: name.value.trim(), category: cat.value }));
      close(true); render();
    } }, field(t('type.name'), name), field(t('type.category'), cat), h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
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
    } }, h('p', { class: 'vw-hint' }, t('set.passHint')), field(t('create.pass'), p1), field(t('create.pass2'), p2), msg,
    h('div', { class: 'vw-actions' }, h('button', { class: 'vw-btn vw-primary', type: 'submit' }, t('save'))));
  });
}

// ---- shell ----

async function render() {
  const app = $app();
  const head = h('header', { class: 'vw-head' },
    h('div', { class: 'vw-brand' }, h('span', { class: 'vw-logo', 'aria-hidden': 'true' }, 'Æ'), h('span', {}, t('app.name'))),
    h('div', { class: 'vw-headr' },
      wallet ? h('span', { class: 'vw-muted' }, wallet.doc.extensions.label || '') : null,
      select(LANGS.map((x) => [x, x.toUpperCase()]), lang),
      wallet ? h('button', { class: 'vw-btn vw-ghost', onclick: lockNow }, t('lock')) : null));
  head.querySelector('select').setAttribute('aria-label', t('language'));
  head.querySelector('select').addEventListener('change', async (e) => { await loadLang(e.target.value); render(); });
  const main = h('main', { class: 'vw-main' }, wallet ? renderWallet() : await renderStart());
  const foot = h('footer', { class: 'vw-foot' }, h('span', {}, wallet ? t('foot.unlocked') : t('foot.locked')), ' ', h('a', { href: 'https://aeilus.institute/tools/' }, 'ÆVRI'));
  app.replaceChildren(head, main, foot);
}

export async function start() {
  let saved = null;
  try { saved = localStorage.getItem('vledger.lang'); } catch { /* ignore */ }
  await loadLang(saved || (navigator.language || 'en').slice(0, 2));
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') touch(); });
  await render();
}

// For tests only.
export const _test = { get wallet() { return wallet; }, set wallet(w) { wallet = w; }, render, valueSentence };
