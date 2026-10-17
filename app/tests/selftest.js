// Value Wallet L1 self-test (format aevri.vledger 1.0-d2): acceptance AT-1...AT-13 of TZ v0.3 at the model level,
// QR encoder cross-check against segno, conformance with the spec fixtures. Run tests/selftest.html over http(s).
import { Wallet, device, passphraseOk, inspectImport } from '../assets/vledger-store.js';
import * as V from '../assets/vledger-value.js';
import * as C from '../assets/vledger-crypto.js';
import { qrMatrix } from '../assets/vledger-qr.js';

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
const near = (a, b, e = 1e-12) => Math.abs(a - b) < e;
const goalsOf = (w) => w.list('goal').map((g) => ({ id: g.rootId, S: g.body.S, N: g.body.N ?? g.body.S, status: g.body.status, systemId: g.body.systemId }));
const systemsOf = (w) => w.list('value-system').map((s) => ({ id: s.rootId, W: s.body.W, status: s.body.status }));

async function run() {
  const PASS = 'test wallet passphrase one two';
  let net = 0;
  const realFetch = window.fetch;
  window.fetch = (...a) => { net++; return realFetch(...a); };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...a) { net++; return realOpen.apply(this, a); };

  // AT-1, AT-2
  ok(!passphraseOk('short') && passphraseOk(PASS), 'passphrase rule: 4 words or 14 characters');
  const store = memory();
  const w = await Wallet.create(PASS, { label: 'Victor', store });
  const me = w.selfContact().rootId;
  ok(/^vw1:[A-Za-z0-9_-]{43}$/.test(w.address) && w.selfContact().body.address === w.address, 'AT-8 wallet has a vw1 address on its self contact');

  // Systems and goals: AT-4
  const fam = await w.add('value-system', { title: 'Family', W: 3, status: 'active' });
  const city = await w.add('value-system', { title: 'City', W: 1, status: 'active', registryUrl: 'https://example-municipality.test/vledger/registry.json' });
  const gClose = await w.add('goal', { title: 'Be close to my daughter', systemId: fam, S: 1, status: 'active', factIds: [] });
  const gMove = await w.add('goal', { title: 'Get around safely', systemId: city, S: 1, status: 'active', factIds: [] });
  const r4 = V.assessValue(goalsOf(w), systemsOf(w), [{ goalId: gClose, k: 0.3 }], [{ goalId: gMove, k: 0.2 }]);
  ok(near(r4.v, 0.225) && near(r4.spentV, 0.05) && near(r4.efficiency, 4.5, 1e-9), 'AT-4 systems 3 and 1: v 22.5%, spent 5%, efficiency 4.5');

  // AT-3 three roles
  const daughter = await w.add('contact', { type: 'person', name: 'Daughter' });
  const shop = await w.add('contact', { type: 'organization', name: 'Corner shop' });
  const mun = await w.add('contact', { type: 'state', name: 'Municipality' });
  const hug = await w.add('event', { actor: daughter, action: 'hugged', objects: [], affected: [me], role: 'affected', occurredAt: '2026-10-17', systemId: fam, status: 'confirmed', stamps: [], rulings: [] });
  const buy = await w.add('event', { actor: me, action: 'bought', objects: [{ label: 'Toothpaste', quantity: 1 }], affected: [shop], role: 'actor', occurredAt: '2026-10-16', status: 'confirmed', stamps: [], rulings: [] });
  const road = await w.add('event', { actor: me, action: 'walk on', objects: [{ label: 'Road along the river' }], affected: [], role: 'user', occurredAt: '2026-10-15', systemId: city, registryRef: { registryUrl: 'https://example-municipality.test/vledger/registry.json', itemId: 'road-17' }, status: 'confirmed', stamps: [], rulings: [] }, { source: 'registry' });
  ok(['affected', 'actor', 'user'].every((r) => w.list('event').some((e) => e.body.role === r)), 'AT-3 events with the holder as affected, actor and user');

  // AT-5 plan from the registry counts 0; retro only after realized
  await w.add('plan', { eventId: road, objectIndex: 0, author: mun, promise: 'A safe walk to the centre', plannedV: 0.01 });
  ok(V.planFactor(w.settings(), { contactId: mun, systemId: city }) === 0, 'AT-5 promised value counts 0 by default');
  ok(!V.retroAllowed(w.list('assessment').map((a) => a.body), road), 'AT-5 retro not allowed before a realized assessment');
  const a1 = await w.add('assessment', { eventId: hug, phase: 'realized', gained: ['Warmth'], lost: [], contributions: [{ goalId: gClose, k: 0.05 }], spent: [], v: 0.0375, reference: true, confidence: 'high' });
  await w.add('assessment', { eventId: road, objectIndex: 0, phase: 'realized', gained: ['Quiet walk'], lost: [], contributions: [{ goalId: gMove, k: 0.08 }], spent: [], v: 0.02, reference: false, confidence: 'medium' });
  ok(V.retroAllowed(w.list('assessment').map((a) => a.body), road, 0), 'AT-5 retro allowed after the realized assessment');

  // AT-6 reference shown for the same system
  const refs = w.list('assessment').filter((a) => a.body.reference).map((a) => ({ sys: w.get(a.body.eventId).body.systemId, v: a.body.v }));
  ok(refs.length === 1 && refs[0].sys === fam && V.nearestReference(refs, 0.075).ratio === 2, 'AT-6 own reference in the Family system; a new value of 7.5% is twice it');

  // AT-7, AT-12 analytics
  const an = V.analytics(w.list('event').map((e) => ({ id: e.rootId, ...e.body })), w.list('assessment').map((a) => ({ ...a.body, createdAt: a.createdAt })), me);
  ok(an.total.all.events === 3 && an.total.all.assessed === 2 && an.byContact[shop].events === 1 && an.byContact[shop].assessed === 0, 'AT-7 the unassessed purchase is on the timeline and counted');
  ok(an.bySystem[fam].events === 1 && near(an.bySystem[fam].v, 0.0375) && an.byRole.user.events === 1 && an.byAction.hugged.events === 1, 'AT-12 analytics by system, role and action match a manual count');

  // AT-8 a pasted address creates a contact; AT-9 messages
  const { doc: bDoc, session: sb } = await C.createWallet('daughter wallet passphrase test', {});
  const wb = new Wallet(bDoc, sb, null);
  const pasted = C.parseAddress(C.addressLink(sb.address, { name: 'Daughter', kind: 'person' }));
  ok(pasted.address === sb.address && pasted.name === 'Daughter', 'AT-8 a wallet link is parsed into address, name and kind');
  const cardB = await C.makeCard(sb, { kind: 'person', name: 'Daughter', storage: { stores: true, purpose: 'Family memories', retentionDays: 3650, publishes: 'no' } });
  await w.addCard(cardB);
  const dContact = w.contactByAddress(sb.address);
  ok(dContact && dContact.body.card && (await C.verifyCard(dContact.body.card)), 'AT-8 contact added from a signed card');
  const share = { kind: 'share', event: { actor: 'Daughter', action: 'hugged', objects: [], affected: ['me'] }, phase: 'realized', gained: ['Warmth'], lost: [], v: 0.0375, publish: 'no' };
  const msg = await w.prepareShare(dContact.rootId, share, { about: a1 });
  const opened = await C.openMessage(sb, msg);
  ok(opened.verified && opened.from === w.address && C.canon(opened.body) === C.canon(share), 'AT-9 the recipient decrypts the share and verifies the sender');
  let third = false; try { await C.openMessage(w.session, msg); third = true; } catch { /* expected */ }
  ok(!third && !JSON.stringify(msg).includes('Warmth'), 'AT-9 nobody else can read it; the message holds no plain text');
  ok(w.list('message-out').length === 1, 'AT-9 the sent message is recorded in the wallet (digest only)');

  // AT-10 request blocking by value system
  const sm = (await C.createWallet('municipality wallet passphrase', {})).session;
  const myCard = await w.card();
  await w.saveSettings({ ...w.settings(), requests: { blockAll: false, blockSystems: [city], blockContacts: [] } });
  const reqCity = await C.sealMessage(myCard, { kind: 'request', event: { actor: 'me', action: 'walk on', objects: ['Road'] }, system: 'City', systemRegistryUrl: 'https://example-municipality.test/vledger/registry.json' }, sm);
  const reqFam = await C.sealMessage(myCard, { kind: 'request', event: { actor: 'me', action: 'visited', objects: ['Grandma'] }, system: 'Family' }, sm);
  const before = w.list('message-in').length;
  const r1 = await w.receive(reqCity);
  const r2 = await w.receive(reqFam);
  ok(r1.dropped === true && !r2.dropped && w.list('message-in').length === before + 1, 'AT-10 the City request is dropped silently, the Family one arrives');

  // AT-11 suggestions stay out of the timeline until confirmed
  const hub = (await C.createWallet('home hub passphrase test', {})).session;
  await w.receive(await C.sealMessage(myCard, { kind: 'suggestion', source: 'Home hub', events: [{ actor: 'me', action: 'cooked', objects: ['Dinner'], affected: ['Daughter'] }] }, hub));
  const sug = w.list('event').find((e) => e.body.status === 'suggested');
  const an2 = V.analytics(w.list('event').map((e) => ({ id: e.rootId, ...e.body })), [], me);
  ok(sug && sug.body.affected.includes(daughter) && an2.total.all.events === 3, 'AT-11 suggested event resolved to contacts and kept out of the timeline');
  await w.correct(sug.rootId, { ...sug.body, status: 'confirmed' });
  ok(w.list('event').filter((e) => e.body.status === 'confirmed').length === 4, 'AT-11 confirmed event joins the timeline');

  // AT-1, AT-13 storage
  const ser = JSON.stringify(store.m.get(w.id));
  ok(!/Daughter|Toothpaste|hugged|Warmth|Family|river/.test(ser), 'AT-1 the stored wallet holds no plain text');
  ok(net === 0, `AT-13 no network requests during wallet work (${net})`);
  window.fetch = realFetch;
  XMLHttpRequest.prototype.open = realOpen;

  const stored = await store.get(w.id);
  let wrong = false; try { await Wallet.unlock(stored, PASS + 'x', null); wrong = true; } catch { /* expected */ }
  const w2 = await Wallet.unlock(stored, PASS, null);
  ok(!wrong && w2.address === w.address && w2.list('event').length === 4, 'AT-2 wrong passphrase refused; the right one reopens with the same address');
  await device.put(stored);
  const back = await device.get(stored.walletId);
  await device.remove(stored.walletId);
  ok(back.records.length === stored.records.length, 'IndexedDB put, get, remove');

  // QR cross-check with segno (see make_qr_vectors.py; segno pads one extra zero byte, see vledger-qr.js)
  const vec = await (await fetch('qr-vectors.json')).json();
  const same = vec.every((t) => qrMatrix(t.text, { version: t.version, mask: t.mask, segnoQuirk: true }).every((row, y) => row.map((c) => (c ? '1' : '0')).join('') === t.matrix[y]));
  ok(same, `QR encoder equals segno module by module (${vec.length} symbols, versions ${[...new Set(vec.map((x) => x.version))].join(', ')})`);

  // Conformance with spec fixtures
  const fx = await (await fetch('../../spec/fixtures/wallet-a.vledger.json')).json();
  const plain = await (await fetch('../../spec/fixtures/wallet-a.plain.json')).json();
  const ins = await inspectImport(fx);
  const fw = await Wallet.unlock(fx, plain.passphrase, null);
  const live = plain.records.filter((r) => r.payload);
  ok(ins.ok && ins.chain.length === 0 && live.every((r) => C.canon(fw.items.get(r.id).payload) === C.canon(r.payload)) && fw.address === plain.address, `spec fixture wallet opens with the same ${live.length} records and address`);
  const fb = await (await fetch('../../spec/fixtures/wallet-b.vledger.json')).json();
  const pb = await (await fetch('../../spec/fixtures/wallet-b.plain.json')).json();
  const fwb = await Wallet.unlock(fb, pb.passphrase, null);
  const mShare = await (await fetch('../../spec/fixtures/message-share-to-daughter.json')).json();
  const rcv = await fwb.receive(mShare);
  ok(rcv.verified && rcv.body.kind === 'share', 'spec fixture share message is received by wallet B');
  const mReq = await (await fetch('../../spec/fixtures/message-request-city.json')).json();
  ok((await fw.receive(mReq)).dropped === true, 'spec fixture City request is dropped by wallet A settings');
  const pairs = [['vledger-crypto.js', 'vledger-crypto.js'], ['vledger-value.js', 'vledger-value.js']];
  let identical = true;
  for (const [a, b] of pairs) identical &&= (await (await fetch('../assets/' + a)).text()) === (await (await fetch('../../spec/reference/' + b)).text());
  ok(identical, 'app uses the reference modules unchanged');

  const failed = results.filter((r) => !r.ok).length;
  document.getElementById('sum').textContent = failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`;
  window.__result = { passed: results.length - failed, failed, results };
}

run().catch((e) => { console.error(e); ok(false, 'exception: ' + e.message); window.__result = { error: e.message, results }; });
