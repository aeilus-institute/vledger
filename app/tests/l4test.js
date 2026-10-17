// Value Wallet L4 tests: bridges to VET (the wallet hosts VET) and VSS (VSS hosts the wallet), SPEC 16.
// Uses mock-vet.html for VET and this page as the VSS host. No server needed.
import { Wallet } from '../assets/vledger-store.js';
import { vetOpenPayload, acceptVetResult, openVet, transferSummary, transfersFor, vssRefOf } from '../assets/vledger-bridge.js';

const out = document.getElementById('out');
const results = [];
function ok(cond, name) {
  results.push({ ok: !!cond, name });
  const li = document.createElement('li');
  li.className = cond ? 'pass' : 'fail';
  li.textContent = (cond ? 'PASS ' : 'FAIL ') + name;
  out.append(li);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memory = () => { const m = new Map(); return { put: async (d) => { m.set(d.walletId, JSON.parse(JSON.stringify(d))); }, get: async (id) => m.get(id) }; };
const UI = { title: 'VET', loading: 'loading', unsupported: 'unsupported', timeout: 'timeout', close: 'close' };
const LABELS = { title: 'Test', out: 'What I received', in: 'What it cost me to receive' };
const closeDialog = async () => { await sleep(800); const d = document.querySelector('dialog.vw-vet-dialog'); const s = d?.querySelector('p')?.textContent; d?.querySelector('.vw-x')?.click(); return s; };
const flowRef = { vssSchemaId: 'schema-1', flowId: 'flow-7', flowLabel: 'Advice', sourceNode: { name: 'Mentor' }, targetNode: { name: 'Me' } };

async function run() {
  // ---- 16.1 the wallet hosts VET ----
  const W = await Wallet.create('L4 test wallet passphrase', { label: 'L4', store: memory() });
  const me = W.selfContact().rootId;
  const mentor = await W.add('contact', { type: 'person', name: 'Mentor' });
  const evId = await W.add('event', { actor: mentor, action: 'advised', objects: [{ label: 'Career advice' }, { label: 'A book' }], affected: [me], role: 'affected', occurredAt: '2026-10-17', status: 'confirmed', stamps: [], rulings: [] });
  const ev = W.get(evId);
  const p = vetOpenPayload(W, ev, null, { lang: 'en', labels: LABELS });
  ok(p.mode === 'receiver' && p.ledgerRef.ledgerId === W.doc.walletId && p.ledgerRef.entryId === evId && p.ledgerRef.assessorId === W.address, 'ledger.open names the wallet, the event and the assessor');
  ok(p.items.length === 2 && p.items[1].title === 'A book' && p.items[1].ledgerRef.objectIndex === 1 && p.axes.in.label === LABELS.in, 'one item per object, with the receiver axes');
  const ev2Id = await W.add('event', { actor: mentor, action: 'hugged', objects: [], affected: [me], role: 'affected', occurredAt: '2026-10-17', status: 'confirmed', stamps: [], rulings: [] });
  ok(vetOpenPayload(W, W.get(ev2Id), null, { labels: LABELS }).items[0].title === 'hugged', 'an event without objects gives one item named after the action');

  let threw = false;
  try { await acceptVetResult({ boardId: 'b', ledgerRef: { ...p.ledgerRef, entryId: 'x' }, totals: {}, extensions: { aevriLedger: { boardSnapshot: {} } } }, p.ledgerRef); } catch { threw = true; }
  ok(threw, 'a result about another event is refused');

  const vet = await openVet({ url: 'mock-vet.html', payload: p, ui: UI });
  ok(vet && vet.boardId === 'board-' + evId && vet.totals.sumOut === 6 && vet.totals.sumIn === 2, 'VET answers and the wallet keeps the totals');
  ok(vet && vet.snapshotHash.startsWith('sha256:') && vet.boardSnapshot.rev === 1 && !vet.boardSnapshot.reopened, 'the board snapshot is kept with its hash');
  const again = await openVet({ url: 'mock-vet.html', payload: vetOpenPayload(W, ev, vet, { labels: LABELS }), ui: UI });
  ok(again && again.boardId === vet.boardId && again.boardSnapshot.reopened && again.revision === 2, 'opening VET again continues the same board');
  const aId = await W.add('assessment', { eventId: evId, phase: 'realized', gained: [], lost: [], contributions: [], spent: [], reference: false, confidence: 'medium', vet: again });
  ok(W.get(W.rootOf(aId)).body.vet.totals.sumOut === 6 && W.get(W.rootOf(aId)).body.v === undefined, 'the VET result is stored in the assessment and does not set v');

  const pending = openVet({ url: 'mock-vet.html?mode=wrong', payload: p, ui: UI });
  const msgWrong = await closeDialog();
  ok((await pending) === null && /another event/.test(msgWrong || ''), 'a VET answer about another event is not accepted');
  const pendingOld = openVet({ url: 'mock-vet.html?mode=old', payload: p, ui: UI });
  const msgOld = await closeDialog();
  ok((await pendingOld) === null && msgOld === 'unsupported', 'a VET without receiver mode is told apart');
  ok((await openVet({ url: 'mock-vet.html?mode=cancel', payload: p, ui: UI })) === null, 'cancel in VET changes nothing');

  // ---- 16.2 summaries ----
  const tId = await W.add('event', { actor: mentor, action: 'Advice', objects: [], affected: [me], role: 'affected', occurredAt: '2026-10-16', status: 'confirmed', stamps: [], rulings: [], vssRef: vssRefOf({ flowRef }) });
  const t = W.get(tId);
  const sf = transferSummary(W, t, 'fact');
  ok(sf.occurredAt === '2026-10-16' && sf.role === 'affected' && sf.assessed === false && !('v' in sf), 'by default VSS sees only the fact, the date and the role');
  await W.add('assessment', { eventId: tId, phase: 'realized', gained: [], lost: [], contributions: [], spent: [], reference: false, confidence: 'medium', v: 0.02, spentV: 0.01 });
  ok(transferSummary(W, t, 'value').v === 0.02 && !('v' in transferSummary(W, t, 'fact')), 'value and cost only when the holder allows it');
  ok(transfersFor(W, flowRef).length === 1 && transfersFor(W, { ...flowRef, flowId: 'other' }).length === 0, 'transfers are listed per flow');

  // ---- 16.2 VSS hosts the wallet ----
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:900px;height:600px;border:1px solid #ccc';
  const got = [];
  window.addEventListener('message', (e) => { if (e.source === frame.contentWindow && e.data?.protocol === 'aevri.vledger') got.push(e.data); });
  frame.src = '../index.html?embed=vss&selftest';
  document.body.append(frame);
  await new Promise((r) => frame.addEventListener('load', r, { once: true }));
  await sleep(1500);
  const fd = frame.contentDocument;
  ok(!got.some((m) => m.type === 'ledger.ready'), 'the embedded wallet says nothing before a wallet is open');
  [...fd.querySelectorAll('button')].find((b) => b.textContent === 'Create a wallet' || b.textContent === 'Создать кошелёк').click();
  await sleep(300);
  const dlg = fd.querySelector('dialog[open]');
  dlg.querySelector('input[type=text]').value = 'VSS embed test';
  dlg.querySelectorAll('input[type=password]').forEach((i) => { i.value = 'embedded wallet test passphrase'; });
  dlg.querySelector('input[type=checkbox]').checked = true;
  dlg.querySelector('form').requestSubmit();
  for (let i = 0; i < 60 && !got.some((m) => m.type === 'ledger.ready'); i++) await sleep(250);
  const ready = got.find((m) => m.type === 'ledger.ready');
  ok(ready && ready.payload.capabilities.includes('transfers-v1'), 'ledger.ready once the wallet is open');

  const send = (type, requestId, payload) => frame.contentWindow.postMessage({ protocol: 'aevri.vledger', version: 1, type, requestId, payload }, location.origin);
  const waitFor = async (type, requestId) => { for (let i = 0; i < 40; i++) { const m = got.find((x) => x.type === type && x.requestId === requestId); if (m) return m; await sleep(150); } return null; };
  send('vss.transfer.open', 'req-1', { transferContext: { flowRef, elementType: { id: 'et-1', name: 'Knowledge', kind: 'value' }, item: { boardId: 'b1', itemId: 'i1', title: 'Code review' } } });
  await sleep(600);
  const edlg = fd.querySelector('dialog[open]');
  const actionVal = edlg?.querySelector('input[list="vw-actions"]')?.value;
  ok(actionVal === 'Advice' && [...edlg.querySelectorAll('input')].some((i) => i.value === 'Code review'), 'the transfer context pre-fills the event dialog');
  const nameBox = edlg.querySelector('.vw-inline:not([hidden]) input[type=text]');
  if (nameBox) nameBox.value = 'Mentor';
  edlg.querySelector('form').requestSubmit();
  const saved = await waitFor('ledger.transfer.saved', 'req-1');
  ok(saved && saved.payload.ledgerRef.entryId && saved.payload.summary.assessed === false && !('v' in saved.payload.summary), 'the confirmed transfer comes back as ledger.transfer.saved with the fact only');
  const fw = frame.contentWindow.vledgerTest.wallet;
  const fev = fw.get(saved.payload.ledgerRef.entryId);
  ok(fev && fev.body.vssRef.flowId === 'flow-7' && fev.body.vssRef.elementTypeId === 'et-1' && fev.body.vssRef.item.itemId === 'i1', 'the event keeps the vssRef');

  send('vss.transfer.open', 'req-2', { transferContext: { flowRef } });
  await sleep(600);
  fd.querySelector('dialog[open] .vw-icon')?.click();
  ok(!!(await waitFor('ledger.cancel', 'req-2')), 'closing the dialog answers ledger.cancel');

  send('vss.transfers.list', 'req-3', { flowRef });
  const list = await waitFor('ledger.transfers', 'req-3');
  ok(list && list.payload.transfers.length === 1 && list.payload.transfers[0].ledgerRef.entryId === fev.rootId, 'vss.transfers.list returns the transfers of the flow');
  await fw.add('assessment', { eventId: fev.rootId, phase: 'realized', gained: [], lost: [], contributions: [], spent: [], reference: false, confidence: 'medium', v: 0.05 });
  send('vss.transfer.summary', 'req-4', { entryId: fev.rootId });
  const s1 = await waitFor('ledger.transfer.summary', 'req-4');
  ok(s1 && s1.payload.summary.assessed === true && !('v' in s1.payload.summary), 'the summary says it was assessed, without the value');
  await fw.saveSettings({ ...fw.settings(), bridges: { vss: { share: 'value' } } });
  send('vss.transfer.summary', 'req-5', { entryId: fev.rootId });
  const s2 = await waitFor('ledger.transfer.summary', 'req-5');
  ok(s2 && s2.payload.summary.v === 0.05 && s2.payload.summary.phase === 'realized', 'with "value" allowed, VSS gets the value');

  const failed = results.filter((x) => !x.ok).length;
  document.getElementById('sum').textContent = failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`;
  window.__result = { passed: results.length - failed, failed, results };
}

run().catch((e) => { console.error(e); ok(false, 'exception: ' + e.message); document.getElementById('sum').textContent = 'exception'; window.__result = { error: e.message, results }; });
