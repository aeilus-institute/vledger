// Value Wallet L2 tests: providers, sync between devices, migration, recovery by the provider's key.
// Needs the reference provider: python spec/tools/provider_server.py 8793 --delay 1 --test
import { Wallet } from '../assets/vledger-store.js';
import { HttpProvider, GitHubProvider, restoreCode, parseRestoreCode } from '../assets/vledger-providers.js';
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
const BASE = 'http://127.0.0.1:8793';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dump = async () => JSON.stringify(await (await fetch(BASE + '/v1/debug/dump')).json());
const PLAIN = /Daughter|Toothpaste|hugged|Warmth|Family|secret note/;

async function run() {
  const PASS = 'test wallet passphrase one two';
  const NEWPASS = 'a brand new passphrase after recovery';
  const http = { id: 'p-ref', kind: 'custom', url: BASE + '/v1', ageConfirmed: true };
  const gh = { id: 'p-gh', kind: 'github', config: { owner: 'holder', repo: 'private-wallet', branch: 'main', token: 'test-token', apiBase: BASE + '/gh' } };

  // Record every request body to prove that only ciphertext leaves the device
  const sent = [];
  const realFetch = window.fetch;
  window.fetch = (url, opts = {}) => { sent.push({ url: String(url), body: opts.body || '' }); return realFetch(url, opts); };

  // Device A
  const A = await Wallet.create(PASS, { label: 'Victor', store: memory() });
  const me = A.selfContact().rootId;
  const fam = await A.add('value-system', { title: 'Family', W: 3, status: 'active' });
  const d = await A.add('contact', { type: 'person', name: 'Daughter' });
  await A.add('event', { actor: d, action: 'hugged', objects: [], affected: [me], role: 'affected', occurredAt: '2026-10-17', systemId: fam, status: 'confirmed', stamps: [], rulings: [] });
  await A.add('note', { text: 'secret note' });
  await A.saveProvider(http);
  const s1 = await A.syncWith(http);
  const head = await new HttpProvider(BASE + '/v1').header(A.id);
  ok(s1.keyring === 'uploaded' && s1.up === A.doc.records.length && head.records === A.doc.records.length, `AT-L2-1 first sync uploads keyring and all ${s1.up} records`);
  ok(!PLAIN.test(await dump()), 'AT-L2-6 the provider holds no plain text (full dump checked)');
  const meta = JSON.parse(await dump()).wallets[A.id];
  ok(Object.keys(meta).sort().join() === 'address,createdAt,cursor,keyring,records', 'AT-L2-7 provider metadata: address, creation time, keyring, envelopes, its cursor');

  // Device B restores from the provider
  const code = restoreCode(http, A.id);
  const parsed = parseRestoreCode(code);
  ok(parsed && parsed.walletId === A.id && parsed.url === http.url, 'restore code round trip: ' + code.slice(0, 40) + '...');
  let wrong = false; try { await Wallet.restore(parsed, A.id, PASS + 'x', memory()); wrong = true; } catch { /* expected */ }
  const B = await Wallet.restore(parsed, A.id, PASS, memory());
  ok(!wrong && B.list('event').length === 1 && B.address === A.address && (await B.verify()).length === 0, 'AT-L2-2 a second device restores the same wallet (wrong passphrase refused, chain rebuilt)');

  // Two devices add, sync, erase
  const xa = await A.add('note', { text: 'from A' });
  const xb = await B.add('note', { text: 'from B' });
  await A.syncWith(http); await B.syncWith(http); await A.syncWith(http);
  const notes = (w) => w.list('note').map((n) => n.body.text).sort().join('|');
  ok(notes(A) === notes(B) && notes(A).includes('from A') && notes(A).includes('from B'), 'AT-L2-2 both devices see both new records after sync');
  await B.eraseItem(xa);
  await B.syncWith(http); await A.syncWith(http);
  const stored = JSON.parse(await dump()).wallets[A.id].records[xa][1];
  ok(!A.list('note').some((n) => n.rootId === xa) && stored.erased && !stored.ct, 'AT-L2-8 erasure on one device reaches the provider (ciphertext gone) and the other device');
  ok((await A.verify()).length === 0 && (await B.verify()).length === 0, 'both device chains intact after merges');

  // Passphrase change on A is adopted by B
  await A.changePassphrase('another passphrase for both devices');
  const s2 = await A.syncWith(http);
  const s3 = await B.syncWith(http);
  let oldOpens = false; try { await Wallet.unlock(B.doc, PASS, null); oldOpens = true; } catch { /* expected */ }
  ok(s2.keyring === 'uploaded' && s3.keyring === 'adopted' && !oldOpens && (await Wallet.unlock(B.doc, 'another passphrase for both devices', null)).address === A.address, 'passphrase change travels as a newer keyring');

  // Wallet proof: another wallet cannot write
  const intruder = await Wallet.create('intruder wallet passphrase here', { store: memory() });
  let forged = false;
  try { await new HttpProvider(BASE + '/v1').putKeyring({ ...A.doc, keyring: intruder.doc.keyring }, intruder.session); forged = true; } catch { /* expected */ }
  let forged2 = false;
  try { await new HttpProvider(BASE + '/v1').append(A.id, [{ ...A.doc.records[0], id: C.uuid7() }], intruder.session); forged2 = true; } catch { /* expected */ }
  ok(!forged && !forged2, 'writes without the wallet\'s own key are refused (keyring and records)');

  // GitHub (mock of the contents API) and migration
  const sg = await A.syncWith(gh);
  const G = await Wallet.restore(gh, A.id, 'another passphrase for both devices', memory());
  ok(sg.up === A.doc.records.length && notes(G) === notes(A) && G.list('event').length === 1, 'AT-L2-9 copy in a private GitHub repository restores on a third device');
  const ghIds = new Set((await new GitHubProvider(gh.config).list(A.id)).map((r) => r.id));
  const complete = A.doc.records.every((r) => ghIds.has(r.id));
  await new HttpProvider(BASE + '/v1').deleteWallet(A.id, A.session);
  ok(complete && (await new HttpProvider(BASE + '/v1').header(A.id)) === null, 'AT-L2-9 migration: GitHub copy verified complete, then the old provider copy deleted');
  await A.syncWith(http); // back to the reference provider for the recovery test

  // Recovery by the provider's key (D-9)
  const offer = await A.enableRecovery(http);
  const slot = A.doc.keyring.slots.find((s) => s.kind === 'provider-recovery');
  ok(offer.canRead === true && slot && slot.keyId === offer.keyId, 'recovery slot added; the provider says it could read the wallet in this mode');
  const p = new HttpProvider(BASE + '/v1');
  const req1 = await p.requestRecovery(A.id, slot.id, 'phone +000');
  const seen = await A.syncWith(http);
  ok(seen.notices.some((n) => n.requestId === req1.requestId), 'a pending recovery request is shown to the holder\'s devices on sync');
  await p.cancelRecovery(req1.requestId, A.session);
  ok((await p.pollRecovery(req1.requestId, req1.privateKey)).status === 'cancelled', 'the holder cancels it from a device');
  const req2 = await p.requestRecovery(A.id, slot.id, 'phone +000');
  ok((await p.pollRecovery(req2.requestId, req2.privateKey)).status === 'waiting', 'no release before the identity check and the delay');
  await realFetch(BASE + '/v1/debug/approve/' + req2.requestId, { method: 'POST' });
  await sleep(1200);
  const rel = await p.pollRecovery(req2.requestId, req2.privateKey);
  ok(rel.status === 'ready' && rel.dek.length === 32, 'after the procedure the DEK is released to the requesting device');
  ok((await p.pollRecovery(req2.requestId, req2.privateKey)).status === 'released', 'the release is given only once');
  const R = await Wallet.recoverWithDek(http, A.id, rel.dek, NEWPASS, memory());
  let oldR = false; try { await Wallet.unlock(R.doc, 'another passphrase for both devices', null); oldR = true; } catch { /* expected */ }
  ok(R.list('event').length === 1 && !oldR && (await Wallet.unlock(R.doc, NEWPASS, null)).address === A.address, 'AT-L2-10 recovered device opens with the new passphrase; the old one no longer does');
  const sA = await A.syncWith(http);
  ok(sA.keyring === 'adopted', 'the other device takes the new keyring on its next sync');

  // Self-custody: without a recovery slot the provider cannot release anything
  await A.disableRecovery({ ...http, recovery: { slotId: slot.id, keyId: offer.keyId } });
  let noSlot = false; try { await p.requestRecovery(A.id, slot.id); noSlot = true; } catch { /* expected */ }
  ok(!noSlot && !A.doc.keyring.slots.some((s) => s.kind === 'provider-recovery'), 'AT-L2-4 after turning recovery off nobody can recover the wallet');

  window.fetch = realFetch;
  const leaked = sent.filter((x) => PLAIN.test(x.body));
  ok(sent.length > 20 && !leaked.length, `no request body carried plain text (${sent.length} requests checked)`);
  ok(sent.every((x) => x.url.startsWith(BASE)), 'requests went only to the chosen providers');

  const failed = results.filter((r) => !r.ok).length;
  document.getElementById('sum').textContent = failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`;
  window.__result = { passed: results.length - failed, failed, results };
}

run().catch((e) => { console.error(e); ok(false, 'exception: ' + e.message); document.getElementById('sum').textContent = 'exception'; window.__result = { error: e.message, results }; });
