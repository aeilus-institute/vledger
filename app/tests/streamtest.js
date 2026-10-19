// Value Wallet event stream tests (SPEC 20): links, descriptors, pairing with fingerprints, pull and push intake,
// dedup and rev rules, finding yourself, rules, pause and leave with a signed receipt, feedback with receipts and
// withdrawal, that nothing goes back to a provider by itself, and closed streams with attestations (20.13).
// Needs a freshly started reference server: python spec/tools/provider_server.py 8796 --test (another port: ?port=)
import { Wallet } from '../assets/vledger-store.js';
import * as S from '../assets/vledger-streams.js';
import * as C from '../assets/vledger-crypto.js';

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
const keyMemory = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (r) => { m.set(r.key, r); }, remove: async (k) => { m.delete(k); }, m }; };
const BASE = `http://127.0.0.1:${new URLSearchParams(location.search).get('port') || 8796}/v1`;
const RELAY = BASE + '/relay';
const dbg = async (action, name, body) => {
  const r = await fetch(`${BASE}/debug/streams/${action}/${name}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok ? r.json() : null;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = (w, rec) => S.pendingOf(w, rec);
const recOf = (w, id) => ({ rootId: id, body: w.get(id).body });

async function wallet(label) {
  const w = await Wallet.create(`${label} wallet passphrase for stream tests`, { label, store: memory() });
  await w.saveSettings({ ...w.settings(), relays: [RELAY] });
  return w;
}

// Pairs a wallet with a private reference stream. `link` as the QR code would carry it.
async function pair(w, keys, name, linkFor) {
  const c = await dbg('code', name, {});
  const link = S.parseStreamLink(linkFor(c));
  const info = await S.inspectLink(link);
  const p = await S.startPairing(w, info, link.code, keys);
  let got = await p.poll();
  ok(got === null, `${name}: nothing is connected before the provider's owner approves`);
  let seen = null;
  for (let i = 0; i < 20 && !seen; i++) { seen = (await dbg('pairings', name)).find((x) => x.status === 'pending'); if (!seen) await wait(150); }
  ok(seen && seen.fingerprint8 === p.fingerprint8.replace(' ', ''), `${name}: the provider shows the same 8 fingerprint characters as the wallet (${p.fingerprint8})`);
  await dbg('approve', name, { fingerprint8: seen.fingerprint8 });
  for (let i = 0; i < 20 && !got; i++) { got = await p.poll(); if (!got) await wait(150); }
  ok(got && got.subscriptionId, `${name}: subscribed after approval`);
  const id = await S.addStream(w, { descriptor: got.descriptor, descriptorUrl: link.url, subscriptionId: got.subscriptionId, ks: p.ks, relay: p.relay, card: info.card });
  return { id, p, c, info };
}

async function run() {
  // ---- links and fingerprints ----
  const l1 = S.parseStreamLink('https://aeilus.institute/tools/vledger/#stream=' + encodeURIComponent('https://example.org/s/d.json') + '&code=ABC_def-123');
  ok(l1 && l1.url === 'https://example.org/s/d.json' && l1.code === 'ABC_def-123', 'a link with a descriptor URL and a code is read');
  const addr = 'vw1:' + 'A'.repeat(43);
  const l2 = S.parseStreamLink('stream=' + addr + '&code=x&relay=' + encodeURIComponent('https://r.example/api/relay/'));
  ok(l2 && l2.address === addr && l2.relay === 'https://r.example/api/relay', 'pasted text with an address, code and relay is read');
  ok(!S.parseStreamLink('https://aeilus.institute/tools/vledger/#stream=javascript:alert(1)') && !S.parseStreamLink('#stream=http://evil.example/x'), 'other schemes and plain http to other hosts are refused');
  const fp = await S.fingerprint(addr);
  ok(/^[A-Z2-7]{51}$/.test(fp) && fp === await S.fingerprint(addr) && S.fp8(fp).length === 9, 'a fingerprint is base32 of SHA-256 of the address');

  // ---- open stream (city): no pairing, the wallet only pulls ----
  const keys = keyMemory();
  const A = await wallet('Victor');
  const cityUrl = BASE + '/streams/city/descriptor';
  const city = await S.inspectLink(S.parseStreamLink('#stream=' + encodeURIComponent(cityUrl)));
  ok(city.kind === 'descriptor' && city.stream.access === 'open' && city.stream.identifies === 'holder', 'an open descriptor verifies and says the holder finds themself');
  const forged = JSON.parse(JSON.stringify(city.doc)); forged.stream.policy.deletesOnLeave = false;
  let bad = null; try { await S.verifyDescriptor(forged); } catch (e) { bad = e.code; }
  ok(bad === 'bad-signature', 'a descriptor changed after signing is refused');
  const cityId = await S.addStream(A, { descriptor: city.doc, descriptorUrl: cityUrl });
  await dbg('emit', 'city', { events: [
    { eventId: 'rw-1', kind: 'visit', actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'opened', objects: [{ label: 'the new road to Kolossi', type: 'thing' }],
      participants: [{ ref: 'muni', label: 'Kourion municipality', role: 'actor' }, { ref: 'r1', label: 'Resident of Kolossi', role: 'user' }], summary: '<b>not markup</b>', source: { label: 'Notice', url: 'https://example.org/notice' } },
    { eventId: 'rw-2', actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'closed', objects: [{ label: 'the old bridge' }] },
  ] });
  let r = await S.refresh(A, cityId, keys);
  let rec = recOf(A, cityId);
  ok(r.added === 2 && pending(A, rec).length === 2, 'pulled events land as suggestions');
  const ev1 = pending(A, rec).find((e) => e.body.streamRef.eventId === 'rw-1');
  ok(ev1.source === 'stream' && ev1.body.status === 'suggested' && ev1.body.streamRef.rev === 1 && A.get(ev1.body.suggestedBy).body.address === city.stream.provider.address, 'a suggestion keeps source stream, streamRef and the provider as suggestedBy');
  ok(ev1.body.streamInfo.needsSelf && !S.resolved(ev1.body) && ev1.body.streamInfo.summary === '<b>not markup</b>', 'with participants the wallet asks "which of these is you?" and keeps text as text');
  ok(rec.body.cursor === '2', 'the cursor moves after the events are stored');
  r = await S.refresh(A, cityId, keys);
  ok(r.added === 0 && pending(A, rec).length === 2, 'pulling again adds nothing twice');

  await S.setSelf(A, cityId, 'r1');
  const ev1b = A.get(ev1.rootId);
  ok(ev1b.body.role === 'user' && !ev1b.body.streamInfo.needsSelf && ev1b.body.actor === '', 'the holder said which participant is them; the role follows');
  const muni = await A.add('contact', { type: 'organization', name: 'Kourion' });
  await S.mapContact(A, cityId, 'muni', muni);
  ok(A.get(ev1.rootId).body.actor === muni && S.resolved(A.get(ev1.rootId).body), 'mapping the actor to a contact resolves the suggestion');
  // the provider is never told
  ok(!JSON.stringify(await (await fetch(BASE + '/debug/dump')).json()).includes(A.address), 'the provider and relay never see the main wallet address');

  // corrections and withdrawals
  const rw2 = pending(A, rec).find((e) => e.body.streamRef.eventId === 'rw-2');
  await dbg('emit', 'city', { events: [{ eventId: 'rw-2', rev: 2, actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'closed for repairs', objects: [{ label: 'the old bridge' }] }] });
  await S.refresh(A, cityId, keys);
  ok(A.get(rw2.rootId).body.action === 'closed for repairs' && A.get(rw2.rootId).body.streamRef.rev === 2, 'a higher rev replaces a pending suggestion');
  const sameRev = { eventId: 'rw-2', rev: 2, actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'something else', objects: [] };
  await dbg('emit', 'city', { events: [sameRev] });
  await dbg('emit', 'city', { events: [{ eventId: 'rw-2', rev: 1, actor: { ref: 'muni', label: 'x' }, action: 'older', objects: [] }] });
  r = await S.refresh(A, cityId, keys);
  ok(A.get(rw2.rootId).body.action === 'closed for repairs' && r.suspicious === 1 && recOf(A, cityId).body.suspicious.length === 1, 'different content at the same rev is set aside as suspicious; a lower rev is ignored');
  await dbg('emit', 'city', { events: [{ eventId: 'rw-2', rev: 3, withdrawn: true, actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'closed', objects: [] }] });
  r = await S.refresh(A, cityId, keys);
  ok(r.withdrawn === 1 && !A.get(rw2.rootId) && !pending(A, recOf(A, cityId)).some((e) => e.body.streamRef.eventId === 'rw-2'), 'a withdrawal removes a pending suggestion');

  // confirm by hand, then the provider corrects: the wallet only says so
  await S.confirm(A, [ev1.rootId]);
  ok(A.get(ev1.rootId).body.status === 'confirmed', 'Confirm puts it on the timeline');
  await dbg('emit', 'city', { events: [{ eventId: 'rw-1', rev: 2, actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'opened both lanes of', objects: [{ label: 'the new road to Kolossi' }], participants: [{ ref: 'r1', label: 'Resident', role: 'user' }] }] });
  r = await S.refresh(A, cityId, keys);
  rec = recOf(A, cityId);
  ok(r.corrections === 1 && A.get(ev1.rootId).body.action === 'opened' && rec.body.updates.length === 1, 'a correction of a confirmed event is offered, the record stays as it was');
  await S.acceptUpdate(A, cityId, 'rw-1');
  ok(A.get(ev1.rootId).body.action === 'opened both lanes of' && A.get(ev1.rootId).body.status === 'confirmed' && A.get(ev1.rootId).body.actor === muni && !recOf(A, cityId).body.updates.length, 'accepting it corrects the record and keeps the holder\'s mapping');

  // reject: a correction never brings it back
  await dbg('emit', 'city', { events: [{ eventId: 'rw-3', actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'planted', objects: [{ label: 'trees' }] }] });
  await S.refresh(A, cityId, keys);
  const rw3 = pending(A, recOf(A, cityId)).find((e) => e.body.streamRef.eventId === 'rw-3');
  await S.reject(A, [rw3.rootId]);
  await dbg('emit', 'city', { events: [{ eventId: 'rw-3', rev: 2, actor: { ref: 'muni', label: 'Kourion municipality' }, action: 'planted 40', objects: [{ label: 'trees' }] }] });
  await S.refresh(A, cityId, keys);
  ok(A.get(rw3.rootId).body.status === 'rejected' && !pending(A, recOf(A, cityId)).some((e) => e.body.streamRef.eventId === 'rw-3'), 'a rejected event stays rejected after a correction');

  // a forged event and an event for another stream are dropped
  const forgedEv = { type: 'aevri.vledger.stream-event', version: 1, streamId: city.stream.streamId, eventId: 'fake', rev: 1, occurredAt: '2026-10-19T00:00:00Z', actor: { label: 'x' }, action: 'forged', sig: 'AAAA' };
  r = await S.intake(A, cityId, [forgedEv, { ...forgedEv, streamId: C.uuid7() }]);
  ok(r.dropped === 2 && r.added === 0, 'events with a wrong signature or for another stream are dropped');

  // pending limit
  S.LIMITS.pending = 1;
  await dbg('emit', 'city', { events: [{ eventId: 'rw-4', actor: { ref: 'muni', label: 'M' }, action: 'a', objects: [] }, { eventId: 'rw-5', actor: { ref: 'muni', label: 'M' }, action: 'b', objects: [] }] });
  r = await S.refresh(A, cityId, keys);
  ok(r.paused && recOf(A, cityId).body.paused && recOf(A, cityId).body.pausedReason === 'too-many', 'beyond the pending limit the wallet pauses the stream and says so');
  S.LIMITS.pending = 1000;
  await S.pause(A, cityId, false);

  // ---- private stream over https (brain), the provider identifies the subscriber ----
  const brain = await pair(A, keys, 'brain', (c) => `https://aeilus.institute/tools/vledger/#stream=${encodeURIComponent(c.descriptorUrl)}&code=${encodeURIComponent(c.code)}`);
  let again = null; try { await S.startPairing(A, brain.info, brain.c.code, keys); } catch (e) { again = e.status; }
  ok(again === 403, 'a pairing code works only once');
  const doc = JSON.stringify(A.exportEncrypted()) + JSON.stringify(A.exportReadable());
  const sub = recOf(A, brain.id).body.subscriptions[0];
  ok(sub.address === brain.p.ks.address && !doc.includes('pkcs8') && keys.m.has(`${A.id}|${sub.address}`) && !JSON.stringify([...keys.m.values()]).includes('"d"'), 'the subscription key stays outside the wallet document, sealed on this device');
  await dbg('emit', 'brain', { events: [
    { eventId: 'call-1', kind: 'call', actor: { ref: 'p1', label: 'Anna' }, action: 'agreed', objects: [{ label: 'the pilot plan for Q4', type: 'decision' }],
      participants: [{ ref: 'p1', label: 'Anna', role: 'actor' }, { ref: 'p-owner', label: 'Victor', role: 'affected' }], summary: 'Short summary', confidence: 0.8 },
  ] });
  r = await S.refresh(A, brain.id, keys);
  const call = pending(A, recOf(A, brain.id))[0];
  ok(r.added === 1 && call.body.role === 'affected' && call.body.affected.includes(A.selfContact().rootId) && !call.body.streamInfo.needsSelf && call.body.actor === '', 'the participant marked "you" gives the holder\'s role; the actor waits to be mapped');
  ok(call.body.streamRef.provider === brain.info.stream.provider.address, 'events are verified against the pinned provider key');
  const anna = await A.add('contact', { type: 'person', name: 'Anna' });
  await S.mapContact(A, brain.id, 'p1', anna);
  await S.confirm(A, [call.rootId]);
  ok(A.get(call.rootId).body.status === 'confirmed' && A.get(call.rootId).body.actor === anna, 'Anna in the stream is the holder\'s contact Anna; confirmed');

  // a rule from an event confirmed by hand
  const ruleId = await S.addRule(A, brain.id, { kind: 'call', actorRef: 'p1' }, 'calls with Anna');
  await dbg('emit', 'brain', { events: [
    { eventId: 'call-2', kind: 'call', actor: { ref: 'p1', label: 'Anna' }, action: 'reviewed', objects: [{ label: 'the budget' }], participants: [{ ref: 'p1', label: 'Anna', role: 'actor' }, { ref: 'p-owner', label: 'Victor', role: 'affected' }] },
    { eventId: 'meet-1', kind: 'meeting', actor: { ref: 'p1', label: 'Anna' }, action: 'met', objects: [], participants: [{ ref: 'p1', label: 'Anna', role: 'actor' }, { ref: 'p-owner', label: 'Victor', role: 'affected' }] },
  ] });
  r = await S.refresh(A, brain.id, keys);
  const byRule = A.list('event').filter((e) => e.body.byRule === ruleId);
  ok(r.byRule === 1 && byRule.length === 1 && byRule[0].body.status === 'confirmed' && byRule[0].body.streamRef.eventId === 'call-2', 'a rule confirms matching events and marks them "by rule"; others wait');
  ok(!A.list('assessment').some((a) => a.body.eventId === byRule[0].rootId), 'rules only confirm, they never rate');
  ok(S.ruleCounts(A, recOf(A, brain.id))[ruleId].today === 1, 'the daily summary counts what a rule did today');
  const undone = await S.undoRule(A, brain.id, ruleId);
  ok(undone === 1 && A.get(byRule[0].rootId).body.status === 'suggested' && !recOf(A, brain.id).body.rules.length, 'undo puts everything the rule did back in the queue in one step');

  // nothing goes back by itself: confirm, rate and rules leave the provider without feedback
  await S.confirm(A, [byRule[0].rootId]);
  await A.react(byRule[0].rootId, 100);
  ok((await dbg('feedback', 'brain')).length === 0, 'confirmations, reactions and rules send nothing to the provider');

  // an event for another subscriber is dropped
  const other = await wallet('Other');
  const otherKeys = keyMemory();
  const ob = await pair(other, otherKeys, 'brain', (c) => `#stream=${encodeURIComponent(c.descriptorUrl)}&code=${encodeURIComponent(c.code)}`);
  const sent = await dbg('emit', 'brain', { events: [{ eventId: 'call-3', kind: 'call', actor: { ref: 'p1', label: 'Anna' }, action: 'called', objects: [], participants: [{ ref: 'p-owner', label: 'Owner', role: 'affected' }] }] });
  const forOther = sent.events.find((e) => e.recipient === recOf(other, ob.id).body.subscriptions[0].address);
  r = await S.intake(A, brain.id, [forOther]);
  ok(r.dropped === 1, 'an event addressed to another subscription is dropped');

  // ---- feedback (20.11) ----
  const s = recOf(A, brain.id).body.descriptor.stream;
  ok(S.senderForms(s, true)[0] === 'anonymous' && S.publishChoices(s, 'anonymous').join() === 'no', 'sender forms start with the most private; a fixed publish policy allows only its own value');
  let refused = null;
  try { await S.buildFeedback(A, brain.id, { type: 'assessment', aboutEventRootId: call.rootId, assessment: { reaction: 100 }, publish: 'anonymous', sender: 'anonymous' }, keys); } catch (e) { refused = e.code; }
  ok(refused === 'publish-not-allowed', 'an item that does not match the publish policy is not built');
  const built = await S.buildFeedback(A, brain.id, { type: 'assessment', aboutEventRootId: call.rootId, role: 'affected', assessment: { reaction: 100, words: 'Clear plan, thank you', gained: ['clarity'] }, publish: 'no', sender: 'anonymous' }, keys);
  ok(!built.item.card && !JSON.stringify(built.item).includes(A.address) && !JSON.stringify(built.item).includes(sub.address) && built.item.key !== sub.address, 'an anonymous item carries a fresh key: no card, no wallet or subscription address');
  ok(!('v' in built.item.assessment) && !('contributions' in built.item.assessment), 'only what the holder chose goes: no value, no goals');
  const outId = await S.sendFeedback(A, brain.id, built, { aboutEventRootId: call.rootId, keyStore: keys });
  let f = A.get(outId).body.feedback;
  ok(f.status === 'published' && f.statusRev === 1 && f.receipts.length === 1, 'the provider answers with a signed receipt (moderation none: published)');
  const got = (await dbg('feedback', 'brain')).find((x) => x.item.feedbackId === built.item.feedbackId);
  ok(got && got.item.assessment.words === 'Clear plan, thank you' && got.key === built.item.key, 'the provider got exactly the item shown');
  ok(A.list('message-out').some((m) => m.rootId === outId && m.body.about === call.rootId && m.body.to === s.provider.address), 'a message-out record says what went to whom');
  await S.feedbackRequest(A, outId, 'feedback-withdraw', keys);
  f = A.get(outId).body.feedback;
  ok(f.status === 'withdrawn' && f.statusRev === 2, 'withdrawal is answered "withdrawn"');
  await S.feedbackRequest(A, outId, 'feedback-withdraw', keys);
  ok(A.get(outId).body.feedback.status === 'withdrawn' && (await dbg('feedback', 'brain')).find((x) => x.item.feedbackId === built.item.feedbackId).item.words === undefined, 'withdrawing again is safe; the provider keeps only a tombstone');

  const built2 = await S.buildFeedback(A, brain.id, { type: 'participation', aboutEventRootId: call.rootId, role: 'affected', publish: 'no', sender: 'subscriber' }, keys);
  ok(built2.item.key === sub.address, 'a subscriber item is signed by the subscription key');
  const out2 = await S.sendFeedback(A, brain.id, built2, { aboutEventRootId: call.rootId, keyStore: keys });
  ok(A.get(out2).body.feedback.status === 'published', 'subscriber feedback gets its receipt');
  const built3 = await S.buildFeedback(A, brain.id, { type: 'assessment', aboutEventRootId: call.rootId, assessment: { reaction: 20, v: 0.02 }, publish: 'no', sender: 'named' }, keys);
  ok(built3.item.card && built3.item.card.card.address === A.address && built3.item.assessment.v === 0.02, 'a named item carries the signed card, and v only when ticked');
  const out3 = await S.sendFeedback(A, brain.id, built3, { aboutEventRootId: call.rootId, keyStore: keys });
  ok(A.get(out3).body.feedback.status === 'published', 'named feedback gets its receipt');
  // a receipt for another item or with a wrong hash is not applied
  const fake = { kind: 'feedback-receipt', providerAddress: s.provider.address, streamId: s.streamId, feedbackId: built3.item.feedbackId, itemHash: 'sha256:' + '0'.repeat(64), statusRev: 9, status: 'rejected', sig: 'AAAA' };
  ok(!(await S.applyReceipt(A, fake, s.provider.address)), 'a receipt that does not verify changes nothing');

  // city: moderation before, sender-choice; anonymous new event
  const cs = recOf(A, cityId).body.descriptor.stream;
  ok(S.publishChoices(cs, 'anonymous').join() === 'no,anonymous' && S.publishChoices(cs, 'named').join() === 'no,anonymous,named', 'with sender-choice the holder chooses; named publishing needs a named sender');
  const b4 = await S.buildFeedback(A, cityId, { type: 'event', event: { action: 'used', objects: [{ label: 'the new road to Kolossi' }], occurredAt: '2026-10-19', place: 'Kolossi' }, role: 'user', assessment: { reaction: 100, words: 'Smooth, no lighting at night', planGap: 'below-plan' }, publish: 'anonymous', sender: 'anonymous' }, keys);
  const out4 = await S.sendFeedback(A, cityId, b4, { keyStore: keys });
  ok(A.get(out4).body.feedback.status === 'pending', 'moderation before: the item waits for the owner');
  await dbg('moderate', 'city', { feedbackId: b4.item.feedbackId, status: 'published' });
  await S.feedbackRequest(A, out4, 'feedback-status', keys);
  ok(A.get(out4).body.feedback.status === 'published' && A.get(out4).body.feedback.statusRev === 2, 'asking for the status brings the newer signed receipt');

  // ---- private stream over the relay only (home), reached by its address like a provider at home ----
  const B = await wallet('Daughter');
  const bkeys = keyMemory();
  const home = await pair(B, bkeys, 'home', (c) => `https://aeilus.institute/tools/vledger/#stream=${c.address}&code=${encodeURIComponent(c.code)}&relay=${encodeURIComponent(RELAY)}`);
  ok(home.info.kind === 'card' && recOf(B, home.id).body.descriptor.stream.transport.join() === 'relay', 'by address: the card comes from the relay directory and the descriptor with "subscribed"');
  await dbg('emit', 'home', { events: [{ eventId: 'visit-1', kind: 'visit', actor: { ref: 'p-owner', label: 'Daughter' }, action: 'came home', objects: [{ label: 'after school' }], participants: [{ ref: 'p-owner', label: 'Daughter', role: 'actor' }] }] });
  await wait(300);
  r = await S.refresh(B, home.id, bkeys);
  const visit = pending(B, recOf(B, home.id))[0];
  ok(r.added === 1 && visit.body.actor === B.selfContact().rootId && visit.body.role === 'actor' && S.resolved(visit.body), 'a pushed event arrives through the relay; the holder is the actor');
  ok(await S.askReplay(B, home.id, bkeys), 'the wallet can ask the provider to send again');
  await wait(400);
  r = await S.refresh(B, home.id, bkeys);
  ok(r.added === 0 && r.ignored >= 1, 'a replayed event is recognised and not added twice');
  const hb = await S.buildFeedback(B, home.id, { type: 'assessment', aboutEventRootId: visit.rootId, assessment: { reaction: 500 }, publish: 'no', sender: 'anonymous' }, bkeys);
  const hout = await S.sendFeedback(B, home.id, hb, { aboutEventRootId: visit.rootId, keyStore: bkeys });
  await wait(400);
  await S.checkReceipts(B, hout, bkeys);
  ok(B.get(hout).body.feedback.status === 'published', 'feedback over the relay: the receipt comes to the item key');

  // pause
  await S.pause(B, home.id, true);
  await dbg('emit', 'home', { events: [{ eventId: 'visit-2', actor: { ref: 'p-owner', label: 'Daughter' }, action: 'left', objects: [] }] });
  await wait(300);
  r = await S.refresh(B, home.id, bkeys);
  ok(r.added === 0 && pending(B, recOf(B, home.id)).length === 1, 'Pause stops taking in events');
  await S.pause(B, home.id, false);

  // leave over the relay: pending until the signed receipt comes
  await S.leave(B, home.id, bkeys);
  for (let i = 0; i < 10 && !recOf(B, home.id).body.left; i++) { await wait(200); await S.retryLeave(B, home.id, bkeys).catch(() => {}); }
  const left = recOf(B, home.id).body;
  ok(left.left && left.left.receipt && await S.verifyUnsubscribed(left.left.receipt, left.descriptor.stream) && left.left.receipt.deleted === true, 'Leave over the relay ends with the provider\'s signed "unsubscribed" receipt');
  ok(!bkeys.m.size, 'after leaving, this device\'s subscription key is removed');
  ok(B.get(visit.rootId) && Object.values(await dbg('subs', 'home')).every((x) => !x.active), 'the provider stopped; what the holder had stays');

  // leave over https
  await S.leave(A, brain.id, keys);
  const la = recOf(A, brain.id).body;
  ok(la.left?.receipt?.kind === 'unsubscribed' && !la.leaving && A.get(call.rootId).body.status === 'confirmed', 'Leave over https: signed receipt at once, confirmed events stay');

  // a descriptor that changes the policy waits for the holder
  const newer = await dbg('descriptor', 'city', { policy: { keeps: 'everything, forever', deletesOnLeave: false, rawStays: true } });
  const ch = S.descriptorChange(recOf(A, cityId).body.descriptor.stream, await S.verifyDescriptor(newer));
  await S.offerDescriptor(A, cityId, newer, ch);
  ok(ch === 'approve' && recOf(A, cityId).body.descriptor.stream.policy.deletesOnLeave === true && recOf(A, cityId).body.descriptorOffer, 'a newer descriptor that changes the policy needs the holder\'s approval');

  // forget at once
  await S.forget(A, cityId, keys);
  ok(!A.get(cityId) && A.get(ev1.rootId).body.status === 'confirmed', 'Forget removes the stream; confirmed events stay');

  // ---- closed streams and verified people (20.13) ----
  S.ISSUERS.push(BASE + '/attest');
  const signin = (on) => fetch(BASE + '/debug/attest/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) });
  const iss = await (await fetch(BASE + '/attest/key')).json();
  const found = await S.findIssuer(iss.issuerInfo.issuer);
  ok(found && found.info.issuerName === 'Reference issuer', 'the wallet finds the issuer the stream names by its key and checks its signed description');
  const D = await wallet('Member');
  const dkeys = keyMemory();
  const deptUrl = BASE + '/streams/dept/descriptor';
  const dept = await S.inspectLink(S.parseStreamLink('#stream=' + encodeURIComponent(deptUrl)));
  ok(dept.stream.access === 'attested' && dept.stream.requires.claim === 'member:test-unit' && dept.stream.requires.issuer === iss.issuerInfo.issuer, 'a closed stream says which issuer and claim it trusts');
  await signin(false);
  let err = null; try { await S.startAttested(D, dept, dkeys); } catch (e) { err = e.code; }
  ok(err === 'sign-in' && dkeys.m.size === 0, 'not signed in at the issuer: the wallet says so and keeps no key');
  await signin(true);
  const wrong = async (ks, req, aud) => S.requestAttestation(found, ks, 'account-verified', aud);
  err = null; try { await S.startAttested(D, dept, dkeys, wrong); } catch (e) { err = e.code; }
  ok(err === 'attestation-claim', 'an attestation for another claim is refused before anything is sent');
  const otherAud = async (ks, req) => S.requestAttestation(found, ks, req.claim, { providerAddress: brain.info.stream.provider.address, streamId: brain.info.stream.streamId });
  err = null; try { await S.startAttested(D, dept, dkeys, otherAud); } catch (e) { err = e.code; }
  ok(err === 'attestation-audience', 'an attestation for another stream is refused');
  const da = await S.startAttested(D, dept, dkeys);
  const dsub = await da.poll();
  ok(dsub && dsub.subscriptionId && da.attestation.attestation.subject === da.ks.address, 'with an attestation about the subscription key the closed stream subscribes at once, no code');
  const deptId = await S.addStream(D, { descriptor: dsub.descriptor, descriptorUrl: deptUrl, subscriptionId: dsub.subscriptionId, ks: da.ks, relay: da.relay, attestation: dsub.attestation });
  const kept = S.accessAttestation(recOf(D, deptId));
  ok(kept && kept.claim === 'member:test-unit' && kept.subject === da.ks.address && !recOf(A, brain.id).body.attestations, 'the attestation is kept with this stream only');
  // a provider refuses an attestation about another key
  const stolen = { kind: 'subscribe', streamId: dept.stream.streamId, challenge: (await (await fetch(BASE + '/streams/dept/challenge')).json()).challenge,
    subscriber: { address: B.address, encKey: B.session.exchangePublicJwk }, attestations: [da.attestation] };
  stolen.proof = await C.sign(B.session.signer, C.te.encode(C.canon({ purpose: 'aevri.vledger/1|subscribe-attested', providerAddress: dept.stream.provider.address, streamId: dept.stream.streamId,
    challenge: stolen.challenge, subscriber: stolen.subscriber, attestationHashes: [await C.hashJson(da.attestation)] })));
  const stolenR = await fetch(BASE + '/streams/dept/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stolen) });
  ok(stolenR.status === 403, 'a copied attestation gives nothing without the subject key');
  await dbg('emit', 'dept', { events: [{ eventId: 'news-1', kind: 'publication', actor: { ref: 'unit', label: 'Test unit' }, action: 'published', objects: [{ label: 'the Q4 plan' }], participants: [] }] });
  r = await S.refresh(D, deptId, dkeys);
  ok(r.added === 1 && pending(D, recOf(D, deptId))[0].body.streamRef.eventId === 'news-1', 'events of the closed stream arrive for this subscription');
  await fetch(BASE + '/debug/streams/expire/dept', { method: 'POST', body: '{}' });
  err = null; try { await S.refresh(D, deptId, dkeys); } catch (e) { err = e.code; }
  ok(err === 'vledger/attestation-expired', 'after expiry the provider stops serving the subscription');
  const renewed = await S.renewAccess(D, deptId, dkeys);
  ok(renewed && S.accessAttestation(recOf(D, deptId)).expiresAt === renewed.attestation.expiresAt, 'the holder renews with a fresh attestation for the same key');
  await dbg('emit', 'dept', { events: [{ eventId: 'news-2', actor: { ref: 'unit', label: 'Test unit' }, action: 'announced', objects: [{ label: 'a meeting' }], participants: [] }] });
  r = await S.refresh(D, deptId, dkeys);
  ok(r.added === 1, 'after renewal the stream serves it again');

  // verified feedback: anyone / checked, not named / named
  const ds = recOf(D, deptId).body.descriptor.stream;
  ok(S.senderLevel(ds, 'anonymous') === 'checked' && S.senderLevel(ds, 'named') === 'named' && S.senderLevel(cs, 'anonymous') === 'anyone', 'the wallet shows the three levels: anyone, checked not named, named');
  const news = pending(D, recOf(D, deptId))[0];
  await S.keepAs(D, news.rootId, 'user');
  await S.mapContact(D, deptId, 'unit', await D.add('contact', { type: 'organization', name: 'Test unit' }));
  await S.confirm(D, [news.rootId]);
  err = null; try { await S.buildFeedback(D, deptId, { type: 'assessment', aboutEventRootId: news.rootId, assessment: { reaction: 20 }, publish: 'anonymous', sender: 'anonymous' }, dkeys); } catch (e) { err = e.code; }
  ok(err === 'needs-attestation', 'with feedback.requires an item is not built without an attestation');
  const fbA = await S.buildFeedback(D, deptId, { type: 'assessment', aboutEventRootId: news.rootId, assessment: { reaction: 20 }, publish: 'anonymous', sender: 'anonymous', attest: S.attestWith }, dkeys);
  const fa = fbA.item.attestations[0].attestation;
  ok(fa.subject === fbA.item.key && fa.claim === 'account-verified' && fa.audience.streamId === ds.streamId && fbA.item.key !== da.ks.address, 'checked, not named: an attestation about the one-time key of the item, for this stream');
  const { sig: fsig, ...fRest } = fbA.item;
  ok(await C.verify(C.keyOfAddress(fbA.item.key), C.te.encode(C.canon(fRest)), fsig), 'the item signature covers the attestation');
  const fOut = await S.sendFeedback(D, deptId, fbA, { aboutEventRootId: news.rootId, keyStore: dkeys });
  ok(D.get(fOut).body.feedback.status === 'published', 'the stream accepts the checked item');
  const fbS = await S.buildFeedback(D, deptId, { type: 'participation', aboutEventRootId: news.rootId, publish: 'no', sender: 'subscriber', attest: S.attestWith }, dkeys);
  ok(fbS.item.attestations[0].attestation.subject === da.ks.address && fbS.item.attestations[0].attestation.claim === 'account-verified', 'a subscriber item gets an attestation about the subscription key for the claim feedback needs');
  ok(D.get(await S.sendFeedback(D, deptId, fbS, { aboutEventRootId: news.rootId, keyStore: dkeys })).body.feedback.status === 'published', 'and is accepted');
  const fbN = await S.buildFeedback(D, deptId, { type: 'assessment', aboutEventRootId: news.rootId, assessment: { reaction: 100 }, publish: 'named', sender: 'named' }, dkeys);
  ok(!fbN.item.attestations && fbN.item.card, 'named: identity key and card, no attestation');
  const badAtt = async (ks, req, aud) => S.requestAttestation(found, { address: da.ks.address, signer: da.ks.signer }, req.claim, aud);
  err = null; try { await S.buildFeedback(D, deptId, { type: 'assessment', aboutEventRootId: news.rootId, assessment: { reaction: 0 }, publish: 'anonymous', sender: 'anonymous', attest: badAtt }, dkeys); } catch (e) { err = e.code; }
  ok(err === 'attestation-subject', 'an attestation about another key is not put into an item');

  const failed = results.filter((x) => !x.ok).length;
  document.getElementById('sum').textContent = failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`;
  window.__result = { passed: results.length - failed, failed, results };
}

run().catch((e) => { console.error(e); ok(false, 'exception: ' + e.message + ' ' + (e.stack || '').split('\n')[1]); document.getElementById('sum').textContent = 'exception'; window.__result = { error: e.message, results }; });
