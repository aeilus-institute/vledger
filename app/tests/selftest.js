// Value Wallet L1 self-test: acceptance AT-1...AT-7 (TZ v0.2 section 10) at the model level,
// plus conformance with the L0 fixtures. Run tests/selftest.html over http(s).
import { Wallet, device, passphraseOk, inspectImport } from '../assets/vledger-store.js';
import * as V from '../assets/vledger-value.js';
import { canon } from '../assets/vledger-crypto.js';

const out = document.getElementById('out');
const results = [];
function ok(cond, name) {
  results.push({ ok: !!cond, name });
  const li = document.createElement('li');
  li.className = cond ? 'pass' : 'fail';
  li.textContent = (cond ? 'PASS ' : 'FAIL ') + name;
  out.append(li);
}
const memory = () => { const m = new Map(); return { put: async (d) => { m.set(d.walletId, JSON.parse(JSON.stringify(d))); }, get: async (id) => m.get(id), m }; };
const near = (a, b) => Math.abs(a - b) < 1e-12;

async function run() {
  const PASS = 'test wallet passphrase one two';

  // Network counter: nothing may leave the browser during wallet work (AT-7).
  let net = 0;
  const realFetch = window.fetch;
  window.fetch = (...a) => { net++; return realFetch(...a); };
  const realBeacon = navigator.sendBeacon?.bind(navigator);
  if (realBeacon) navigator.sendBeacon = (...a) => { net++; return realBeacon(...a); };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...a) { net++; return realOpen.apply(this, a); };

  // AT-1 create without an account; storage only ciphertext
  ok(!passphraseOk('short'), 'weak passphrase rejected');
  ok(passphraseOk(PASS), 'four-word passphrase accepted');
  const store = memory();
  const w = await Wallet.create(PASS, { label: 'Test', store });
  ok(w.list('counterparty').some((c) => c.body.type === 'self'), 'AT-1 new wallet has settings and self');

  // AT-3 three kinds of counterparties, exchange with elements of two types
  const anna = await w.add('counterparty', { type: 'person', name: 'Anna' });
  const inst = await w.add('counterparty', { type: 'organization', name: 'Institute' });
  const mun = await w.add('counterparty', { type: 'state', name: 'Municipality' });
  const tThing = await w.add('element-type', { name: 'Thing', category: 'thing' });
  const tInfo = await w.add('element-type', { name: 'Advice', category: 'information' });
  const ex = await w.add('exchange', { counterpartyId: anna, received: [{ label: 'Ballpoint pen', typeId: tThing, quantity: 1 }, { label: 'Advice on letters', typeId: tInfo }], given: [], occurredAt: '2026-10-16', status: 'recorded' });
  ok(w.list('counterparty').length === 4 && w.list('exchange').length === 1 && w.get(ex).body.received.length === 2, 'AT-3 counterparties of three kinds and an exchange with two types');

  // AT-4 goal S = 1 000 000, N = 200 000, contribution 60 000 -> k = 30%
  const gLetter = await w.add('goal', { title: 'Write to my father', S: 1000000, N: 200000, status: 'active', factIds: [] });
  const goals1 = w.list('goal').map((g) => ({ id: g.rootId, S: g.body.S, N: g.body.N, status: g.body.status }));
  const r1 = V.comparableValue(goals1, [{ goalId: gLetter, c: 60000 }]);
  ok(near(r1.parts[0].k, 0.3) && near(r1.v, 0.3), 'AT-4 k = 30%, single goal so v = 30%');
  const gGreek = await w.add('goal', { title: 'Greek', S: 1000000, status: 'active', factIds: [] });
  const goals2 = w.list('goal').map((g) => ({ id: g.rootId, S: g.body.S, N: g.body.N ?? g.body.S, status: g.body.status }));
  const r2 = V.comparableValue(goals2, [{ goalId: gLetter, c: 60000 }]);
  ok(near(r2.v, 0.15), 'AT-4 with a second equal goal v = 15%');
  const as = await w.add('assessment', { exchangeId: ex, phase: 'received', gained: ['Started the letter'], lost: [], ownScore: { value: 1000000, unit: 'points' }, contributions: [{ goalId: gLetter, c: 60000 }], v: r2.v, confidence: 'medium' });
  await w.correct(as, { ...w.get(as).body, contributions: [{ goalId: gLetter, c: 30000 }], v: 0.075 });
  ok(near(w.get(as).body.v, 0.075) && w.list('assessment').length === 1, 'AT-4 "less" correction keeps one current assessment with the new value');

  // AT-5 planned value counted 0 by default, 0.5 only for one counterparty
  await w.add('plan', { exchangeId: ex, elementRef: { exchangeId: ex, side: 'received', index: 0 }, authorCounterpartyId: inst, promise: 'Useful method' });
  ok(V.planFactor(w.settings(), { counterpartyId: inst }) === 0, 'AT-5 plan counts 0 by default');
  await w.saveSettings({ ...w.settings(), planCountBy: [{ counterpartyId: inst, factor: 0.5 }] });
  ok(V.planFactor(w.settings(), { counterpartyId: inst }) === 0.5 && V.planFactor(w.settings(), { counterpartyId: mun }) === 0, 'AT-5 factor 0.5 applies to that counterparty only');

  // AT-6 fact revised, history kept; erase leaves tombstones
  const f = await w.add('fact', { text: 'I have not written to my father for two years', certainty: 'medium', exploring: true, goalIds: [gLetter] });
  await w.correct(f, { text: 'I wrote the first page', certainty: 'high', exploring: false, goalIds: [gLetter] });
  ok(w.versions(f).length === 2 && w.get(f).body.text === 'I wrote the first page', 'AT-6 fact revised, two versions');
  const n = await w.eraseItem(f);
  const ser = JSON.stringify(store.m.get(w.id));
  ok(n === 2 && w.list('fact').length === 0 && !ser.includes('father') && (await w.verify()).length === 0, 'AT-6 erased both versions; chain intact; text gone from storage');
  const tombs = w.doc.records.filter((r) => r.erased).length;
  ok(tombs === 2, 'AT-6 two tombstones remain');

  // AT-1 nothing readable in storage
  ok(!/Anna|Ballpoint|Greek|Municipality|Useful method|points/.test(ser), 'AT-1 stored document holds no plain text');

  // Unlock from the stored copy; wrong passphrase fails
  const stored = await store.get(w.id);
  const w2 = await Wallet.unlock(stored, PASS, null);
  ok(w2.list('exchange').length === 1 && near(w2.get(as).body.v, 0.075), 'stored copy reopens with the passphrase');
  let wrong = false; try { await Wallet.unlock(stored, PASS + 'x', null); wrong = true; } catch { /* expected */ }
  ok(!wrong, 'AT-2 wrong passphrase does not open');

  // Merge a second copy that got one more record
  const fork = await Wallet.unlock(JSON.parse(JSON.stringify(stored)), PASS, null);
  await fork.add('note', { text: 'added on another device' });
  const mr = await w.merge(fork.exportEncrypted());
  ok(mr.added === 1 && w.list('note').length === 1 && (await w.verify()).length === 0, 'merge adds the missing record and keeps the chain');

  // Change passphrase
  await w.changePassphrase('a completely new passphrase here');
  const s3 = await store.get(w.id);
  let oldOk = false; try { await Wallet.unlock(s3, PASS, null); oldOk = true; } catch { /* expected */ }
  ok(!oldOk && (await Wallet.unlock(s3, 'a completely new passphrase here', null)).list('exchange').length === 1, 'passphrase change: old fails, new opens');

  // Readable export is explicit and complete
  const rd = w.exportReadable();
  ok(rd.format === 'aevri.vledger.readable' && rd.records.some((r) => r.payload?.body?.name === 'Anna'), 'readable export holds the plain records');

  // Feeling checks
  const flags = V.feelingChecks([{ id: 'a', S: 1, N: 1, status: 'active' }], [{ at: '2026-10-01T00:00:00Z', contributions: [{ goalId: 'a', k: 0.7 }] }, { at: '2026-10-02T00:00:00Z', contributions: [{ goalId: 'a', k: 0.6 }] }]);
  ok(flags.some((x) => x.code === 'goal-overfilled'), 'feeling check flags an overfilled goal');

  ok(net === 0, `AT-7 no network requests during wallet work (${net})`);
  window.fetch = realFetch;
  if (realBeacon) navigator.sendBeacon = realBeacon;
  XMLHttpRequest.prototype.open = realOpen;

  // Device storage (IndexedDB)
  await device.put(stored);
  const listed = await device.list();
  const back = await device.get(stored.walletId);
  await device.remove(stored.walletId);
  ok(listed.some((x) => x.walletId === stored.walletId) && back.records.length === stored.records.length && !(await device.list()).some((x) => x.walletId === stored.walletId), 'IndexedDB put, list, get, remove');

  // Conformance with L0 fixtures
  const fx = await (await fetch('../../spec/fixtures/wallet-a.vledger.json')).json();
  const plain = await (await fetch('../../spec/fixtures/wallet-a.plain.json')).json();
  const ins = await inspectImport(fx);
  const fw = await Wallet.unlock(fx, plain.passphrase, null);
  const live = plain.records.filter((r) => r.payload);
  const same = live.every((r) => canon(fw.items.get(r.id).payload) === canon(r.payload));
  ok(ins.ok && ins.chain.length === 0 && same, `L0 fixture wallet opens and matches (${live.length} records)`);
  const bad = await (await fetch('../../spec/fixtures/invalid-wallet-tampered.vledger.json')).json();
  ok((await inspectImport(bad)).chain.length === 1, 'L0 tampered fixture shows one problem');
  const a = await (await fetch('../assets/vledger-crypto.js')).text();
  const b = await (await fetch('../../spec/reference/vledger-crypto.js')).text();
  const c = await (await fetch('../assets/vledger-value.js')).text();
  const d = await (await fetch('../../spec/reference/vledger-value.js')).text();
  ok(a === b && c === d, 'app uses the reference modules unchanged');

  const failed = results.filter((r) => !r.ok).length;
  document.getElementById('sum').textContent = failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`;
  window.__result = { passed: results.length - failed, failed, results };
}

run().catch((e) => { ok(false, 'exception: ' + e.message); window.__result = { error: e.message, results }; });
