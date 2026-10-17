// Value Wallet bridges to VET and VSS (SPEC 16, stage L4). postMessage between a page and the frame it embeds, same
// origin only, envelope {protocol, version: 1, type, requestId, payload}. Nothing here talks to a server.
import * as C from './vledger-crypto.js';

export const VET_CAP = 'ledger-receiver-v1';
export const VSS_CAP = 'transfers-v1';

const sameRef = (a, b) => !!a && !!b && a.ledgerId === b.ledgerId && a.entryId === b.entryId && (a.assessorId || null) === (b.assessorId || null);

// ---- 16.1 the wallet hosts VET ----

// ledger.open payload for one event: one item per object, or one named after the action.
export function vetOpenPayload(wallet, ev, prevVet, { lang = 'en', labels }) {
  const ledgerRef = { ledgerId: wallet.doc.walletId, entryId: ev.rootId, assessorId: wallet.address };
  const objs = ev.body.objects || [];
  const items = (objs.length ? objs : [{ label: ev.body.action }]).map((o, i) => ({
    title: String(o.label || ev.body.action).slice(0, 300),
    ledgerRef: { ledgerId: ledgerRef.ledgerId, entryId: ledgerRef.entryId, ...(objs.length ? { objectIndex: i } : {}) },
  }));
  return {
    mode: 'receiver', ledgerRef, title: labels.title, lang, items,
    axes: { out: { label: labels.out }, in: { label: labels.in } },
    extensions: { aevriLedger: { schemaVersion: '1.0', boardSnapshot: prevVet?.boardSnapshot || null, boardId: prevVet?.boardId || null } },
  };
}

// Checks a vet.result and turns it into the `vet` part of an assessment (SPEC 16.1 step 4).
export async function acceptVetResult(result, ledgerRef, receivedAt = C.nowIso()) {
  if (!result || typeof result !== 'object' || !sameRef(result.ledgerRef, ledgerRef)) throw new Error('the VET result is about another event');
  const ext = result.extensions?.aevriLedger || {};
  if (!ext.boardSnapshot || typeof ext.boardSnapshot !== 'object' || typeof result.boardId !== 'string') throw new Error('the VET result has no board');
  if (!result.totals || typeof result.totals !== 'object') throw new Error('the VET result has no totals');
  const snapshot = JSON.parse(JSON.stringify(ext.boardSnapshot));
  return {
    boardId: result.boardId, resultId: String(ext.resultId || ''), revision: Number(ext.resultRevision) || 0,
    totals: JSON.parse(JSON.stringify(result.totals)), axes: JSON.parse(JSON.stringify(result.axes || {})),
    receivedAt, snapshotHash: await C.hashJson(snapshot), boardSnapshot: snapshot,
  };
}

// Opens VET in a modal frame and resolves with the checked `vet` object, or null when the holder cancels or VET cannot
// do this. `ui` gives the strings and the dialog look: {title, loading, unsupported, timeout, close}.
export function openVet({ url, payload, ui, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const requestId = C.uuid7();
    const frame = document.createElement('iframe');
    frame.className = 'vw-vet-frame';
    frame.title = 'VET';
    frame.src = url;
    const status = document.createElement('p');
    status.className = 'vw-muted vw-small';
    status.textContent = ui.loading;
    const dlg = document.createElement('dialog');
    dlg.className = 'vw-dialog vw-vet-dialog';
    dlg.setAttribute('aria-label', ui.title);
    const head = document.createElement('div');
    head.className = 'vw-dialog-head';
    const title = document.createElement('h2');
    title.textContent = ui.title;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'vw-x'; x.textContent = '×'; x.setAttribute('aria-label', ui.close);
    head.append(title, x);
    dlg.append(head, status, frame);
    document.body.append(dlg);
    let state = 'loading';
    const timer = setTimeout(() => { if (state === 'loading') { state = 'failed'; status.textContent = ui.timeout; } }, timeoutMs);
    const finish = (v) => { window.removeEventListener('message', onMsg); clearTimeout(timer); dlg.close(); dlg.remove(); resolve(v); };
    x.addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    const send = (type, p) => frame.contentWindow.postMessage({ protocol: 'aevri.vet', version: 1, type, requestId, payload: p }, location.origin);
    async function onMsg(e) {
      if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
      const m = e.data;
      if (!m || m.protocol !== 'aevri.vet' || m.version !== 1) return;
      if (m.type === 'vet.ready' && state === 'loading') {
        clearTimeout(timer);
        if (!(m.payload?.capabilities || []).includes(VET_CAP)) { state = 'failed'; status.textContent = ui.unsupported; return; }
        state = 'editing'; status.textContent = '';
        send('ledger.open', payload);
        return;
      }
      if (m.requestId !== requestId) return;
      if (m.type === 'vet.cancel') { finish(null); return; }
      if (m.type === 'vet.result') {
        try { finish(await acceptVetResult(m.payload, payload.ledgerRef)); } catch (err) { status.textContent = err.message; }
      }
    }
    window.addEventListener('message', onMsg);
    dlg.showModal();
  });
}

// ---- 16.2 VSS hosts the wallet ----

export const sameFlow = (a, b) => !!a && !!b && a.vssSchemaId === b.vssSchemaId && a.flowId === b.flowId;

// What the holder allows VSS to see about one transfer (settings.bridges.vss.share).
export function transferSummary(wallet, ev, share = 'fact') {
  const as = wallet.list('assessment').filter((a) => a.body.eventId === ev.rootId).sort((x, y) => x.firstAt.localeCompare(y.firstAt));
  const latest = as.filter((a) => a.body.phase === 'retro').pop() || as.filter((a) => a.body.phase === 'realized').pop();
  const s = { occurredAt: String(ev.body.occurredAt), role: ev.body.role, assessed: !!latest };
  if (share === 'value' && latest) {
    if (typeof latest.body.v === 'number') s.v = latest.body.v;
    if (typeof latest.body.spentV === 'number') s.spentV = latest.body.spentV;
    s.phase = latest.body.phase;
  }
  return s;
}

const ledgerRefOf = (wallet, ev) => ({ ledgerId: wallet.doc.walletId, entryId: ev.rootId });
const shareOf = (wallet) => (wallet.settings().bridges?.vss?.share === 'value' ? 'value' : 'fact');

export function transfersFor(wallet, flowRef) {
  const share = shareOf(wallet);
  return wallet.list('event').filter((e) => e.body.status !== 'rejected' && sameFlow(e.body.vssRef, flowRef))
    .map((e) => ({ ledgerRef: ledgerRefOf(wallet, e), summary: transferSummary(wallet, e, share) }));
}

// The vssRef an event keeps for a transfer context (SPEC 16.2).
export function vssRefOf(ctx) {
  const f = ctx.flowRef;
  return { vssSchemaId: String(f.vssSchemaId).slice(0, 100), flowId: String(f.flowId).slice(0, 100),
    ...(f.flowLabel ? { flowLabel: String(f.flowLabel).slice(0, 300) } : {}),
    ...(ctx.elementType?.id ? { elementTypeId: String(ctx.elementType.id).slice(0, 100) } : {}),
    ...(ctx.item ? { item: { boardId: String(ctx.item.boardId || ''), itemId: String(ctx.item.itemId || ''), title: String(ctx.item.title || '').slice(0, 300) } } : {}) };
}

// The wallet inside VSS. getWallet() returns the open wallet or null; recordTransfer(ctx) opens the event dialog and
// resolves with the new event root id or null. Call ready() each time a wallet becomes open.
export function embedForVss({ getWallet, recordTransfer }) {
  const on = window.parent !== window;
  let announced = false;
  const post = (type, requestId, payload) => window.parent.postMessage({ protocol: 'aevri.vledger', version: 1, type, requestId, payload }, location.origin);
  window.addEventListener('message', async (e) => {
    if (!on || e.origin !== location.origin || e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.protocol !== 'aevri.vledger' || m.version !== 1 || typeof m.requestId !== 'string') return;
    const w = getWallet();
    if (!w) return; // nothing is answered before a wallet is open; VSS waits for ledger.ready
    const p = m.payload || {};
    if (m.type === 'vss.transfer.open' && p.transferContext?.flowRef?.vssSchemaId && p.transferContext.flowRef.flowId) {
      const id = await recordTransfer(p.transferContext);
      const ev = id && w.get(id);
      if (ev) post('ledger.transfer.saved', m.requestId, { ledgerRef: ledgerRefOf(w, ev), summary: transferSummary(w, ev, shareOf(w)) });
      else post('ledger.cancel', m.requestId, {});
    } else if (m.type === 'vss.transfers.list' && p.flowRef) {
      post('ledger.transfers', m.requestId, { flowRef: p.flowRef, transfers: transfersFor(w, p.flowRef) });
    } else if (m.type === 'vss.transfer.summary' && typeof p.entryId === 'string') {
      const ev = w.get(p.entryId);
      if (ev && ev.body.vssRef) post('ledger.transfer.summary', m.requestId, { ledgerRef: ledgerRefOf(w, ev), summary: transferSummary(w, ev, shareOf(w)) });
    }
  });
  return {
    on,
    ready() { if (on && !announced) { announced = true; post('ledger.ready', 'ready', { capabilities: [VSS_CAP] }); } },
    reset() { announced = false; },
  };
}
