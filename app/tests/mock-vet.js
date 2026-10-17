// Mock of VET in receiver mode (SPEC 16.1) for l4test. ?mode=old: no ledger capability; ?mode=wrong: answers about
// another event; ?mode=cancel: cancels. Otherwise it puts 3 on the out axis and 1 on the in axis for every item.
const mode = new URLSearchParams(location.search).get('mode') || 'ok';
const post = (type, requestId, payload) => window.parent.postMessage({ protocol: 'aevri.vet', version: 1, type, requestId, payload }, location.origin);
window.received = [];
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.protocol !== 'aevri.vet' || m.type !== 'ledger.open') return;
  window.received.push(m.payload);
  const p = m.payload;
  if (mode === 'cancel') { post('vet.cancel', m.requestId, {}); return; }
  const prev = p.extensions?.aevriLedger?.boardSnapshot;
  const boardId = prev?.id || p.extensions?.aevriLedger?.boardId || 'board-' + p.ledgerRef.entryId;
  const items = p.items.map((it, i) => ({ id: 'i' + i, title: it.title, out: 3, in: 1, ledgerRef: it.ledgerRef }));
  const ledgerRef = mode === 'wrong' ? { ...p.ledgerRef, entryId: '00000000-0000-7000-8000-000000000000' } : p.ledgerRef;
  post('vet.result', m.requestId, {
    boardId, ledgerRef, items, axes: { out: { label: p.axes.out.label }, in: { label: p.axes.in.label } },
    totals: { count: items.length, sumOut: 3 * items.length, sumIn: items.length },
    extensions: { aevriLedger: { schemaVersion: '1.0', resultId: 'r-' + Date.now(), resultRevision: (prev?.rev || 0) + 1,
      boardSnapshot: { id: boardId, rev: (prev?.rev || 0) + 1, items, reopened: !!prev } } },
  });
});
post('vet.ready', 'ready', { capabilities: mode === 'old' ? ['vss-board-snapshot-v1'] : ['vss-board-snapshot-v1', 'ledger-receiver-v1'] });
document.getElementById('state').textContent = 'mock VET ready (' + mode + ')';
