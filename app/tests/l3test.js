// Value Wallet L3 tests: relay, card directory, sharing through the relay, joint confirmation of events, arbiter stamps.
// Needs the reference server: python spec/tools/provider_server.py 8793 --delay 1 --test
import { Wallet } from '../assets/vledger-store.js';
import { RelayClient, ArbiterClient } from '../assets/vledger-providers.js';
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
const BASE = 'http://127.0.0.1:8793/v1';
const RELAY = BASE + '/relay';
const ARB = BASE + '/arbiter';
const dump = async () => JSON.stringify(await (await fetch(BASE + '/debug/dump')).json());
const PLAIN = /helped|Warmth|Moving the sofa|secret words/;

async function wallet(label) {
  const w = await Wallet.create(`${label} wallet passphrase for tests`, { label, store: memory() });
  await w.saveSettings({ ...w.settings(), relays: [RELAY] });
  return w;
}

async function run() {
  const A = await wallet('Victor');
  const B = await wallet('Daughter');

  // Card directory
  await A.publishCard();
  await B.publishCard();
  const cardA = await B.lookupCard(A.address);
  ok(cardA && cardA.card.address === A.address && (await C.verifyCard(cardA)), 'a published card is found by address and verifies');
  await B.addCard(cardA);
  await A.addCard(await A.lookupCard(B.address));
  const bInA = A.contactByAddress(B.address);
  ok(bInA && bInA.body.card, 'each wallet adds the other from the directory');
  const forged = JSON.parse(JSON.stringify(cardA)); forged.card.name = 'Somebody else';
  let refused = false; try { await new RelayClient(RELAY).publishCard(forged); } catch { refused = true; }
  ok(refused, 'the relay refuses a card whose signature does not match');

  // Share through the relay
  const share = { kind: 'share', event: { actor: 'Daughter', action: 'helped', objects: ['Moving the sofa'] }, phase: 'realized', gained: ['Warmth'], lost: [], v: 0.03, publish: 'no' };
  const msg = await A.prepareShare(bInA.rootId, share);
  ok(await A.deliver(msg), 'A sends the share through the relay');
  ok(!PLAIN.test(await dump()), 'the relay holds only ciphertext (full dump checked)');
  const got = await B.checkInbox();
  ok(got.received === 1 && B.list('message-in').some((m) => m.body.body.kind === 'share' && m.body.verified), 'B receives and verifies it');
  ok((await B.checkInbox()).received === 0 && !JSON.stringify(JSON.parse(await dump()).inboxes).includes(B.address), 'the relay deleted it after delivery');
  let stranger = false;
  try { const C2 = await wallet('Stranger'); await new RelayClient(RELAY).inbox({ ...C2.session, address: B.address }); stranger = true; } catch { /* expected */ }
  ok(!stranger, 'nobody else can open B\'s inbox');

  // Joint confirmation with a binding mandate naming the arbiter
  const meA = A.selfContact().rootId;
  const ev = await A.add('event', { actor: bInA.rootId, action: 'helped', objects: [{ label: 'Moving the sofa' }], affected: [meA], role: 'affected', occurredAt: '2026-10-17', status: 'confirmed', stamps: [], rulings: [] });
  const arbiter = await new ArbiterClient(ARB).ref();
  const offer = await A.offerEvent(ev, bInA.rootId, { mode: 'binding', arbiter: { url: arbiter.url, key: arbiter.key } });
  ok(A.get(ev).body.receiptState === 'offered', 'A\'s event is marked as offered');
  await A.deliver(offer);
  await B.checkInbox();
  const offerIn = B.list('message-in').find((m) => m.body.body.kind === 'event-offer');
  ok(offerIn && offerIn.body.body.opening.action.text === 'helped', 'B sees what it is asked to confirm (the opening)');
  const acc = await B.acceptOffer(offerIn.rootId);
  const evB = B.get(acc.eventId);
  ok(acc.matched && evB.body.receiptState === 'matched' && evB.body.actor === B.selfContact().rootId, 'B records the event on its own timeline as the actor, signed by both');
  await B.deliver(acc.reply);
  const back = await A.checkInbox();
  const evA = A.get(ev);
  ok(back.matched === 1 && evA.body.receiptState === 'matched', 'A receives the countersigned receipt: matched');
  const dA = await C.receiptDigest(evA.body.receipt.receipt);
  ok(dA === await C.receiptDigest(evB.body.receipt.receipt) && (await C.receiptStatus(evA.body.receipt)).binding, 'both hold the same receipt; the binding mandate exists because both signed');

  // Arbiter stamp and lookup
  const stamp = await A.stampAt(ev, ARB);
  ok(stamp.receiptDigest === dA && A.get(ev).body.stamps.length === 1, 'the arbiter stamps the digest; the stamp verifies and is kept with the event');
  ok(!PLAIN.test(JSON.stringify(JSON.parse(await dump()).stamps)), 'the arbiter keeps no content (digest, key thumbprints, time)');
  const seen = await new ArbiterClient(ARB).lookup(dA, B.session);
  ok(seen && seen.length === 1, 'a party can look the stamp up');
  let outsider = false;
  try { const O = await wallet('Outsider'); await new ArbiterClient(ARB).lookup(dA, O.session); outsider = true; } catch { /* expected */ }
  ok(!outsider, 'a non-party cannot');

  // Tampered reply is not accepted as matched
  const ev2 = await A.add('event', { actor: bInA.rootId, action: 'cooked', objects: [], affected: [meA], role: 'affected', occurredAt: '2026-10-17', status: 'confirmed', stamps: [], rulings: [] });
  const off2 = await A.offerEvent(ev2, bInA.rootId);
  await A.deliver(off2); await B.checkInbox();
  const in2 = B.list('message-in').find((m) => m.body.body.kind === 'event-offer' && m.body.body.opening?.action.text === 'cooked');
  const bundle = JSON.parse(JSON.stringify(in2.body.body.receipt));
  bundle.receipt.occurredAt = '2026-10-16T00:00:00Z';
  await C.signReceipt(bundle, 1, B.session);
  await B.deliver(await C.sealMessage(B.contactByAddress(A.address).body.card, { kind: 'event-offer', receipt: bundle }, B.session));
  await A.checkInbox();
  ok(A.get(ev2).body.receiptState === 'disputed', 'a reply that changes the receipt marks the event as disputed, not matched');

  // Request blocking over the relay
  const fam = await A.add('value-system', { title: 'City', W: 1, status: 'active' });
  await A.saveSettings({ ...A.settings(), requests: { blockAll: false, blockSystems: [fam], blockContacts: [] } });
  const mun = await wallet('Municipality');
  await mun.deliver(await C.sealMessage(await A.card(), { kind: 'request', event: { actor: 'me', action: 'walk on', objects: ['Road'] }, system: 'City' }, mun.session));
  const r = await A.checkInbox();
  ok(r.dropped === 1 && r.received === 0, 'a request in a blocked system is dropped when fetched from the relay');

  // Withdraw the card
  await B.withdrawCard();
  ok((await A.lookupCard(B.address)) === null, 'a withdrawn card is no longer in the directory');

  const failed = results.filter((x) => !x.ok).length;
  document.getElementById('sum').textContent = failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`;
  window.__result = { passed: results.length - failed, failed, results };
}

run().catch((e) => { console.error(e); ok(false, 'exception: ' + e.message); document.getElementById('sum').textContent = 'exception'; window.__result = { error: e.message, results }; });
