// Value Wallet: event streams (SPEC 20, d9). No DOM.
// A provider only suggests: events land as `status: suggested` and reach the timeline when the holder confirms them,
// by hand or by a rule the holder made. Nothing goes back to a provider unless the holder sends it (feedback, 20.11).
// Subscription keys are made per stream and per device and kept outside the wallet document (like SPEC 18).

import * as C from './vledger-crypto.js';
import { RelayClient, AEVRI_RELAY } from './vledger-providers.js';

export const LIMITS = { descriptor: 16384, event: 32768, response: 1048576, depth: 16, participants: 100, objects: 100, pending: 1000 };
const P_SUBSCRIBE = 'aevri.vledger/1|subscribe';
const P_REQUEST = 'aevri.vledger/1|stream-request';
const ADDR = /^vw1:[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const ROLES = ['actor', 'affected', 'user', 'witness'];
const REACTIONS = [-100, -20, 0, 20, 100, 500];
// https everywhere; plain http only on this computer (tests and the reference provider)
export const urlOk = (u) => typeof u === 'string' && u.length <= 2000 && (/^https:\/\/[^\s]+$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u));
const fail = (code, msg = code) => Object.assign(new Error(msg), { code });
const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const bytes = (v) => C.te.encode(JSON.stringify(v)).length;
function depthOk(v, d = 0) {
  if (d > LIMITS.depth) return false;
  return v && typeof v === 'object' ? Object.values(v).every((x) => depthOk(x, d + 1)) : true;
}

// ---- links (20.3) ----

// #stream=<descriptor URL | vw1:address>&code=...&relay=...; also the whole link, a /w/ link or the fragment alone.
export function parseStreamLink(text) {
  const s = String(text || '').trim();
  const i = s.indexOf('#');
  const frag = i >= 0 ? s.slice(i + 1) : s;
  if (!/(^|&)stream=/.test(frag)) return null;
  const p = new URLSearchParams(frag);
  const target = (p.get('stream') || '').trim();
  const out = {};
  if (ADDR.test(target)) out.address = target;
  else if (urlOk(target)) out.url = target;
  else return null;
  const code = p.get('code');
  if (code) out.code = code.trim().slice(0, 100);
  const relay = p.get('relay');
  if (relay && urlOk(relay)) out.relay = relay.replace(/\/$/, '');
  return out;
}

export function streamLink({ url, address, code, relay }, base = 'https://aeilus.institute/tools/vledger/') {
  const p = new URLSearchParams();
  p.set('stream', url || address);
  if (code) p.set('code', code);
  if (relay) p.set('relay', relay);
  return base + '#' + p.toString();
}

// ---- fingerprints (20.3, 20.4): base32 of SHA-256 of the address text; people compare the first 8 characters ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export async function fingerprint(address) {
  const b = await C.sha256(C.te.encode(address));
  let out = '', val = 0, bits = 0;
  for (const x of b) {
    val = ((val << 8) | x) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}
export const fp8 = (fp) => fp.slice(0, 4) + ' ' + fp.slice(4, 8);

// ---- descriptor (20.2) ----

function checkStreamBody(s) {
  if (!s || s.type !== 'aevri.vledger.stream' || s.version !== 1) throw fail('not-descriptor');
  if (!Number.isInteger(s.descriptorRev) || s.descriptorRev < 1 || !UUID.test(s.streamId || '') || !str(s.title)) throw fail('bad-descriptor');
  const pv = s.provider || {};
  if (!ADDR.test(pv.address || '') || !str(pv.name) || pv.encKey?.kty !== 'EC' || pv.encKey?.crv !== 'P-256' || !pv.encKey.x || !pv.encKey.y) throw fail('bad-descriptor');
  if (!['open', 'code', 'attested'].includes(s.access) || !['provider', 'holder'].includes(s.identifies)) throw fail('bad-descriptor');
  if (s.access === 'attested' && !requiresOk(s.requires)) throw fail('bad-descriptor');
  if (s.requires !== undefined && !requiresOk(s.requires)) throw fail('bad-descriptor');
  if (s.access === 'open' && s.identifies !== 'holder') throw fail('bad-descriptor');
  const tr = s.transport;
  if (!Array.isArray(tr) || !tr.length || tr.some((x) => !['https', 'relay'].includes(x))) throw fail('bad-descriptor');
  if (tr.includes('https') && !urlOk(s.endpoint)) throw fail('bad-descriptor');
  if (s.relay !== undefined && !urlOk(s.relay)) throw fail('bad-descriptor');
  if (s.access === 'open' && !tr.includes('https')) throw fail('bad-descriptor');
  const po = s.policy;
  if (!po || typeof po.keeps !== 'string' || typeof po.deletesOnLeave !== 'boolean' || typeof po.rawStays !== 'boolean') throw fail('bad-descriptor');
  if (po.url !== undefined && !urlOk(po.url)) throw fail('bad-descriptor');
  const fb = s.feedback;
  if (fb !== undefined) {
    const okList = (a, allowed) => Array.isArray(a) && a.length && a.every((x) => allowed.includes(x));
    if (!okList(fb.accepts, ['assessment', 'participation', 'event']) || !okList(fb.senders, ['anonymous', 'subscriber', 'named'])
      || !['none', 'before', 'after'].includes(fb.moderation) || !['no', 'anonymous', 'named', 'sender-choice'].includes(fb.publishes)) throw fail('bad-descriptor');
    if (fb.rulesUrl !== undefined && !urlOk(fb.rulesUrl)) throw fail('bad-descriptor');
    if (fb.requires !== undefined && !requiresOk(fb.requires)) throw fail('bad-descriptor');
  }
}

const CLAIM = /^[a-z][a-z0-9-]*(:[A-Za-z0-9._-]{1,80})?$/;
const requiresOk = (r) => !!r && typeof r === 'object' && ADDR.test(r.issuer || '') && typeof r.claim === 'string' && r.claim.length <= 100 && CLAIM.test(r.claim);

// Verifies a signed descriptor; returns the stream body. `pinned` = {providerAddress, streamId} of a known stream.
export async function verifyDescriptor(doc, pinned = null) {
  if (!doc || typeof doc !== 'object' || typeof doc.sig !== 'string') throw fail('not-descriptor');
  if (bytes(doc) > LIMITS.descriptor || !depthOk(doc)) throw fail('too-large');
  checkStreamBody(doc.stream);
  const s = doc.stream;
  if (!(await C.verify(C.keyOfAddress(s.provider.address), C.te.encode(C.canon(s)), doc.sig).catch(() => false))) throw fail('bad-signature');
  if (pinned && (pinned.providerAddress !== s.provider.address || pinned.streamId !== s.streamId)) throw fail('other-stream');
  return s;
}

// How a newer descriptor relates to the one kept (20.2): 'same', 'ignore' (lower or equal rev), 'auto' (titles, kinds),
// 'approve' (endpoint, relay, access, transport, identifies, policy or feedback changed), 'new-key' (another provider key).
export function descriptorChange(oldS, newS) {
  if (oldS.provider.address !== newS.provider.address || oldS.streamId !== newS.streamId) return 'new-key';
  if (newS.descriptorRev <= oldS.descriptorRev) return C.canon(oldS) === C.canon(newS) ? 'same' : 'ignore';
  const keys = ['endpoint', 'relay', 'access', 'transport', 'identifies', 'policy', 'feedback'];
  if (keys.some((k) => C.canon(oldS[k] ?? null) !== C.canon(newS[k] ?? null))) return 'approve';
  if (C.canon(oldS.provider.encKey) !== C.canon(newS.provider.encKey)) return 'approve';
  if (C.canon(oldS.requires ?? null) !== C.canon(newS.requires ?? null)) return 'approve';
  return 'auto';
}

export const relayOf = (s, linkRelay) => (s?.relay || linkRelay || AEVRI_RELAY).replace(/\/$/, '');
const providerCard = (s) => ({ card: { address: s.provider.address, encKey: s.provider.encKey } });

// ---- device-local subscription keys (20.4) ----

// IndexedDB store 'streamkeys' (made by vledger-store.js), or any {get, put, remove} for tests.
export async function newSubscriptionKeys(session, keyStore) {
  const id = await C.newIdentity();
  const ex = await C.newExchangeKey();
  const address = C.addressOf(id.publicKey);
  const key = `${session.walletId}|${address}`;
  const secret = C.te.encode(JSON.stringify({ pkcs8: C.b64u(id.pkcs8), enc: ex.privateJwk }));
  const rec = { key, walletId: session.walletId, address, encKey: ex.publicJwk, wrap: await C.seal(session.dek, secret, 'stream-key', session.walletId, address), createdAt: C.nowIso() };
  await keyStore.put(rec);
  return keySession(session, rec);
}

// A session-shaped object for one subscription key: signs, opens messages for that address, proves it at relays.
export async function keySession(session, rec) {
  const { pkcs8, enc } = JSON.parse(C.td.decode(await C.open(session.dek, rec.wrap, 'stream-key', session.walletId, rec.address)));
  return { address: rec.address, publicKey: C.keyOfAddress(rec.address), signer: await C.importSigner(C.unb64u(pkcs8)), exchangePrivate: await C.importEcdhPrivate(enc), exchangePublicJwk: rec.encKey };
}

export async function loadKeys(wallet, address, keyStore) {
  if (!address) return null;
  const rec = await keyStore.get(`${wallet.id}|${address}`).catch(() => null);
  return rec ? keySession(wallet.session, rec) : null;
}

// A one-item key (anonymous feedback, 20.11) kept inside the wallet record: {pkcs8, enc}
async function itemKeySession(k) {
  const pub = { alg: 'Ed25519', x: k.x };
  return { address: C.addressOf(pub), publicKey: pub, signer: await C.importSigner(C.unb64u(k.pkcs8)), exchangePrivate: await C.importEcdhPrivate(k.enc), exchangePublicJwk: k.encPub };
}

// ---- network ----

async function getJson(url, opts = {}) {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', ...opts });
  const text = await r.text();
  if (text.length > LIMITS.response) throw fail('too-large');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { if (r.ok) throw fail('bad-response'); }
  if (!r.ok) throw Object.assign(fail(body?.code || String(r.status), `${opts.method || 'GET'} ${url}: ${r.status}`), { status: r.status });
  return { status: r.status, body };
}

export async function fetchDescriptor(url) {
  if (!urlOk(url)) throw fail('bad-url');
  const { body } = await getJson(url, { headers: { Accept: 'application/json' } });
  return body;
}

async function requestProof(s, ks, rec, method, url) {
  const { body: ch } = await getJson(s.endpoint.replace(/\/$/, '') + '/challenge');
  const u = new URL(url);
  const signed = { purpose: P_REQUEST, challenge: ch.challenge, method, pathAndQuery: u.pathname + u.search, streamId: s.streamId, subscriptionId: rec.subscriptionId };
  return { 'X-Vledger-Address': ks.address, 'X-Vledger-Challenge': ch.challenge, 'X-Vledger-Proof': await C.sign(ks.signer, C.te.encode(C.canon(signed))) };
}

// ---- connecting and subscribing (20.3, 20.4) ----

// What the connect screen shows, from a parsed link. Returns {kind:'descriptor', doc, stream, origin, fingerprint}
// or {kind:'card', card, address, relay, fingerprint} for a provider reachable only by relay.
export async function inspectLink(link) {
  if (link.url) {
    const doc = await fetchDescriptor(link.url);
    const s = await verifyDescriptor(doc);
    return { kind: 'descriptor', doc, stream: s, origin: new URL(link.url).origin, fingerprint: await fingerprint(s.provider.address), relay: relayOf(s, link.relay), link };
  }
  const relay = (link.relay || AEVRI_RELAY).replace(/\/$/, '');
  const card = await new RelayClient(relay).getCard(link.address);
  if (!card || card.card?.address !== link.address || !(await C.verifyCard(card))) throw fail('no-card');
  return { kind: 'card', card, address: link.address, relay, fingerprint: await fingerprint(link.address), link };
}

export async function subscribeBody(ks, { providerAddress, streamId, code }) {
  const subscriber = { address: ks.address, encKey: ks.exchangePublicJwk };
  const signed = { purpose: P_SUBSCRIBE, providerAddress, code, subscriber };
  if (streamId) signed.streamId = streamId;
  return { kind: 'subscribe', ...(streamId ? { streamId } : {}), code, subscriber, proof: await C.sign(ks.signer, C.te.encode(C.canon(signed))) };
}

// Starts a pairing. Returns a pairing handle: {ks, fingerprint8, poll()} where poll() resolves to null (still waiting
// for the provider's owner) or {subscriptionId, descriptor (signed doc)}.
export async function startPairing(wallet, info, code, keyStore) {
  if (!code || code.length < 22) throw fail('no-code');
  const ks = await newSubscriptionKeys(wallet.session, keyStore);
  const fp = fp8(await fingerprint(ks.address));
  const s = info.stream || null;
  const providerAddress = s ? s.provider.address : info.address;
  const body = await subscribeBody(ks, { providerAddress, streamId: s?.streamId, code });
  const useHttps = s && s.transport.includes('https');
  const relay = s ? relayOf(s, info.relay) : info.relay;
  const pinned = { providerAddress, streamId: s?.streamId };
  const check = async (reply) => {
    if (!reply || reply.kind !== 'subscribed' || typeof reply.subscriptionId !== 'string' || reply.subscriptionId.length > 100) return null;
    if (s && reply.streamId !== s.streamId) return null;
    let doc = info.doc || null;
    if (reply.descriptor) {
      const got = await verifyDescriptor(reply.descriptor, { providerAddress, streamId: reply.streamId });
      if (!doc || got.descriptorRev >= doc.stream.descriptorRev) doc = reply.descriptor;
    }
    if (!doc) return null;
    if (doc.stream.provider.address !== providerAddress || doc.stream.streamId !== reply.streamId) return null;
    return { subscriptionId: reply.subscriptionId, descriptor: doc };
  };
  if (useHttps) {
    const url = s.endpoint.replace(/\/$/, '') + '/subscriptions';
    const send = async () => (await getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).body;
    let first = await send();
    return { ks, fingerprint8: fp, relay, pinned, async poll() {
      // a repeated identical request returns the same answer (20.4)
      const r = first || await send(); first = null;
      return check(r);
    } };
  }
  const rc = new RelayClient(relay);
  const card = s ? providerCard(s) : info.card;
  await rc.send(await C.sealMessage(card, body, ks));
  return { ks, fingerprint8: fp, relay, pinned, async poll() {
    for (const m of await rc.inbox(ks)) {
      try {
        const o = await C.openMessage(ks, m);
        if (!o.verified || o.from !== providerAddress) continue;
        const r = await check(o.body);
        if (r) return r;
      } catch { /* not for us */ }
    }
    return null;
  } };
}

// ---- attestations (20.13): "a checked account", "a member of the unit", about one key, for one stream ----

export const AEVRI_ATTEST = 'https://aeilus.institute/api/v1/vledger/attest';
// Issuers this wallet can ask (base URLs of the issuer API); tests add the reference issuer.
export const ISSUERS = [AEVRI_ATTEST];
const issuerCache = new Map();
const P_ATTEST = 'aevri.vledger/1|attest';
const P_SUB_ATTESTED = 'aevri.vledger/1|subscribe-attested';

// Checks an attestation against what the stream requires. Returns null when valid, otherwise the reason.
export async function checkAttestation(doc, { issuer, claim, subject, audience, at = Date.now() }) {
  const a = doc?.attestation;
  if (!a || typeof doc.sig !== 'string' || a.type !== 'aevri.vledger.attestation' || a.version !== 1) return 'not-attestation';
  if (a.issuer !== issuer) return 'issuer';
  if (a.claim !== claim) return 'claim';
  if (subject && a.subject !== subject) return 'subject';
  if (!a.audience || a.audience.providerAddress !== audience.providerAddress || a.audience.streamId !== audience.streamId || Object.keys(a.audience).length !== 2) return 'audience';
  const from = Date.parse(a.issuedAt), to = Date.parse(a.expiresAt);
  if (!(from <= at + 5 * 60000) || !(to > at)) return 'expired';
  if (!(await C.verify(C.keyOfAddress(issuer), C.te.encode(C.canon(a)), doc.sig).catch(() => false))) return 'bad-signature';
  return null;
}

// The issuer behind a key: asks each known issuer API for its signed description. Returns {base, info} or null.
export async function findIssuer(address) {
  for (const base of ISSUERS) {
    let hit = issuerCache.get(base);
    if (!hit) {
      try {
        const { body } = await getJson(base.replace(/\/$/, '') + '/key');
        const info = body?.issuerInfo;
        if (info?.type === 'aevri.vledger.issuer' && ADDR.test(info.issuer || '') && await C.verify(C.keyOfAddress(info.issuer), C.te.encode(C.canon(info)), body.sig).catch(() => false)) {
          hit = { base: base.replace(/\/$/, ''), info };
          issuerCache.set(base, hit);
        }
      } catch { /* this issuer is not reachable now */ }
    }
    if (hit && hit.info.issuer === address) return hit;
  }
  return null;
}

// Asks an issuer for an attestation about `ks` (a key session) for one stream. The issuer sees the key and the
// stream, never what is sent with the key. Same-origin issuers get the signed-in session; others nothing.
export async function requestAttestation(iss, ks, claim, audience) {
  const base = iss.base;
  const same = typeof location !== 'undefined' && new URL(base).origin === location.origin;
  const opts = { credentials: same ? 'include' : 'omit' };
  let ch;
  try { ch = (await getJson(base + '/challenge', opts)).body; } catch (e) { throw e.status === 401 ? fail('sign-in') : e; }
  const signed = { purpose: P_ATTEST, issuer: iss.info.issuer, subject: ks.address, claim, audience, challenge: ch.challenge };
  const body = { subject: ks.address, claim, audience, challenge: ch.challenge, proof: await C.sign(ks.signer, C.te.encode(C.canon(signed))) };
  let doc;
  try {
    doc = (await getJson(base, { ...opts, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).body;
  } catch (e) {
    if (e.status === 401) throw fail('sign-in');
    if (['vledger/email-not-confirmed', 'vledger/rate'].includes(e.code)) throw fail(e.code.slice(8));
    throw e;
  }
  const bad = await checkAttestation(doc, { issuer: iss.info.issuer, claim, subject: ks.address, audience });
  if (bad) throw fail('attestation-' + bad);
  return doc;
}

// The default way to get one: find the issuer the stream names and ask it
export async function attestWith(ks, requires, audience) {
  const iss = await findIssuer(requires.issuer);
  if (!iss) throw fail('unknown-issuer');
  return requestAttestation(iss, ks, requires.claim, audience);
}

const attHashes = (docs) => Promise.all(docs.map((d) => C.hashJson(d)));

async function attestedBody(ks, s, doc) {
  // the provider's one-time challenge; a stream reached only by relay takes a fresh time-stamped one from the wallet
  const challenge = s.transport.includes('https')
    ? (await getJson(s.endpoint.replace(/\/$/, '') + '/challenge')).body.challenge
    : 't:' + C.nowIso() + ':' + C.b64u(C.rand(16));
  const subscriber = { address: ks.address, encKey: ks.exchangePublicJwk };
  const signed = { purpose: P_SUB_ATTESTED, providerAddress: s.provider.address, streamId: s.streamId, challenge, subscriber, attestationHashes: await attHashes([doc]) };
  return { kind: 'subscribe', streamId: s.streamId, challenge, subscriber, attestations: [doc], proof: await C.sign(ks.signer, C.te.encode(C.canon(signed))) };
}

async function sendSubscribe(s, relay, ks, body, card = null) {
  if (s.transport.includes('https')) return (await getJson(s.endpoint.replace(/\/$/, '') + '/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).body;
  await new RelayClient(relay).send(await C.sealMessage(card || providerCard(s), body, ks));
  return null;
}

// A closed stream (access "attested"): no code; the holder confirms with the issuer the stream trusts, then
// subscribes with that attestation. `attest(ks, requires, audience)` asks the issuer (on the holder's tap).
export async function startAttested(wallet, info, keyStore, attest = attestWith) {
  const s = info.stream;
  if (!s || s.access !== 'attested') throw fail('bad-descriptor');
  const ks = await newSubscriptionKeys(wallet.session, keyStore);
  const audience = { providerAddress: s.provider.address, streamId: s.streamId };
  let doc;
  try {
    doc = await attest(ks, s.requires, audience);
    const bad = await checkAttestation(doc, { ...s.requires, subject: ks.address, audience });
    if (bad) throw fail('attestation-' + bad);
  } catch (e) { await keyStore.remove(`${wallet.id}|${ks.address}`).catch(() => {}); throw e; }
  const relay = relayOf(s, info.relay);
  let first = await sendSubscribe(s, relay, ks, await attestedBody(ks, s, doc));
  const check = (r) => (r && r.kind === 'subscribed' && r.streamId === s.streamId && typeof r.subscriptionId === 'string' && r.subscriptionId.length <= 100 ? { subscriptionId: r.subscriptionId, descriptor: info.doc, attestation: doc } : null);
  const rc = new RelayClient(relay);
  return { ks, fingerprint8: fp8(await fingerprint(ks.address)), relay, attestation: doc, async poll() {
    if (first) { const r = check(first); first = null; if (r) return r; }
    if (!s.transport.includes('relay')) return null;
    for (const m of await rc.inbox(ks)) {
      try { const o = await C.openMessage(ks, m); if (o.verified && o.from === s.provider.address) { const r = check(o.body); if (r) return r; } } catch { /* skip */ }
    }
    return null;
  } };
}

// Attestations kept with the stream record (never on other streams): access for this device's subscription
export function accessAttestation(rec, address) {
  return (rec.body.attestations || []).filter((x) => x.use === 'access' && (!address || x.subject === address)).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0] || null;
}

async function keepAttestation(wallet, rootId, use, doc) {
  const a = doc.attestation;
  return patch(wallet, rootId, (b) => ({ ...b, attestations: [...(b.attestations || []).filter((x) => !(x.use === use && x.subject === a.subject)), { use, subject: a.subject, issuer: a.issuer, claim: a.claim, expiresAt: a.expiresAt, doc }] }));
}

// Renew access before (or after) expiry, only on the holder's tap: a fresh attestation for the same key, sent again
export async function renewAccess(wallet, rootId, keyStore, attest = attestWith) {
  const rec = fresh(wallet, rootId);
  const s = rec.body.descriptor.stream;
  const dk = await deviceKeys(wallet, rec, keyStore);
  if (!dk) throw fail('no-keys');
  const audience = { providerAddress: s.provider.address, streamId: s.streamId };
  const doc = await attest(dk.ks, s.requires, audience);
  const bad = await checkAttestation(doc, { ...s.requires, subject: dk.ks.address, audience });
  if (bad) throw fail('attestation-' + bad);
  const r = await sendSubscribe(s, relayOf(s, rec.body.relay), dk.ks, await attestedBody(dk.ks, s, doc));
  if (r && (r.kind !== 'subscribed' || r.subscriptionId !== dk.subscriptionId)) throw fail('renew-refused');
  await keepAttestation(wallet, rootId, 'access', doc);
  return doc;
}

// Keeps the stream record after a successful pairing, or for an open stream (no pairing). Returns its root id.
export async function addStream(wallet, { descriptor, descriptorUrl, subscriptionId, ks, relay, card, attestation }) {
  const s = await verifyDescriptor(descriptor);
  const existing = streamOf(wallet, s.provider.address, s.streamId);
  const subs = existing ? [...(existing.body.subscriptions || [])] : [];
  if (subscriptionId && ks) subs.push({ subscriptionId, address: ks.address, addedAt: C.nowIso() });
  const body = {
    ...(existing ? existing.body : { selfRefs: [], contactMap: [], rules: [], handled: [], paused: false, addedAt: C.nowIso() }),
    providerAddress: s.provider.address, streamId: s.streamId, descriptor,
    ...(descriptorUrl ? { descriptorUrl } : {}), ...(subscriptionId ? { subscriptionId } : {}), subscriptions: subs,
    ...(relay ? { relay } : {}), ...(card ? { card } : {}), leaving: false,
  };
  delete body.left;
  let id;
  if (existing) { await wallet.correct(existing.rootId, body); id = existing.rootId; } else id = await wallet.add('stream', body, { source: 'stream' });
  if (attestation) await keepAttestation(wallet, id, 'access', attestation);
  return id;
}

export const streams = (wallet) => wallet.list('stream');
export const streamOf = (wallet, providerAddress, streamId) => streams(wallet).find((x) => x.body.providerAddress === providerAddress && x.body.streamId === streamId) || null;
const fresh = (wallet, rootId) => wallet.get(rootId);
async function patch(wallet, rootId, fn) {
  const cur = fresh(wallet, rootId);
  if (!cur) return null;
  const next = fn(JSON.parse(JSON.stringify(cur.body)));
  if (!next || C.canon(next) === C.canon(cur.body)) return cur.body;
  await wallet.correct(rootId, next);
  return next;
}

// The subscription of this device for a stream (or null: open stream, or paired on another device)
export async function deviceKeys(wallet, rec, keyStore) {
  for (const sub of [...(rec.body.subscriptions || [])].reverse()) {
    const ks = await loadKeys(wallet, sub.address, keyStore);
    if (ks) return { ks, subscriptionId: sub.subscriptionId };
  }
  return null;
}

// ---- events (20.5) ----

// Checks one stream event. Returns null when it may be taken in, otherwise the reason it is dropped.
export async function checkEvent(e, s, recipients = []) {
  if (!e || typeof e !== 'object' || e.type !== 'aevri.vledger.stream-event' || e.version !== 1) return 'not-event';
  if (bytes(e) > LIMITS.event || !depthOk(e)) return 'too-large';
  if (e.streamId !== s.streamId) return 'other-stream';
  if (!EVENT_ID.test(e.eventId || '') || !Number.isInteger(e.rev) || e.rev < 1 || typeof e.sig !== 'string') return 'bad-event';
  if (s.access !== 'open') { if (!recipients.includes(e.recipient)) return 'other-recipient'; }
  else if (e.recipient !== undefined) return 'other-recipient';
  const parts = e.participants || [], objs = e.objects || [];
  if (!Array.isArray(parts) || !Array.isArray(objs) || parts.length > LIMITS.participants || objs.length > LIMITS.objects) return 'too-large';
  if (!e.withdrawn && (!str(e.action) || typeof e.occurredAt !== 'string' || !e.actor || !str(e.actor.label))) return 'bad-event';
  if (parts.some((p) => !p || typeof p.ref !== 'string' || typeof p.label !== 'string')) return 'bad-event';
  if (s.identifies === 'provider' && parts.filter((p) => p.you === true).length > 1) return 'bad-event';
  const { sig, ...rest } = e;
  if (!(await C.verify(C.keyOfAddress(s.provider.address), C.te.encode(C.canon(rest)), sig).catch(() => false))) return 'bad-signature';
  return null;
}

// What the wallet knows about each eventId of a stream: {rev, state, hash, eventRoot}
function stateIndex(wallet, rec) {
  const m = new Map();
  for (const x of rec.body.handled || []) m.set(x.eventId, { ...x });
  for (const ev of wallet.list('event')) {
    const r = ev.body.streamRef;
    if (!r || r.provider !== rec.body.providerAddress || r.streamId !== rec.body.streamId) continue;
    const cur = m.get(r.eventId) || {};
    const state = ev.body.status === 'suggested' ? 'pending' : ev.body.status;
    m.set(r.eventId, { eventId: r.eventId, rev: Math.max(cur.rev || 0, r.rev), state: cur.state === 'withdrawn' && state !== 'pending' ? cur.state : state, hash: r.rev >= (cur.rev || 0) ? ev.body.streamInfo?.hash : cur.hash, eventRoot: ev.rootId });
  }
  return m;
}

export function pendingOf(wallet, rec) {
  return wallet.list('event').filter((e) => e.body.status === 'suggested' && e.body.streamRef?.provider === rec.body.providerAddress && e.body.streamRef?.streamId === rec.body.streamId);
}

async function providerContact(wallet, s) {
  const c = wallet.contactByAddress(s.provider.address);
  if (c) return c.rootId;
  const type = { person: 'person', organization: 'organization', state: 'state', group: 'group' }[s.provider.kind] || 'device';
  return wallet.add('contact', { type, name: str(s.provider.name) || 'Stream', address: s.provider.address }, { source: 'stream' });
}

// The participant who is the holder: marked by the provider (identifies: provider) or chosen by the holder
function meOf(rec, e) {
  const s = rec.body.descriptor.stream;
  const parts = e.participants || [];
  if (s.identifies === 'provider') return parts.find((p) => p.you === true) || null;
  const mine = new Set(rec.body.selfRefs || []);
  return parts.find((p) => mine.has(p.ref)) || null;
}

// Maps a stream event to the body of a wallet event (20.6). Unmapped people stay as words until the holder maps them.
export function mapEvent(wallet, rec, e, extra = {}) {
  const self = wallet.selfContact().rootId;
  const me = meOf(rec, e);
  const map = new Map((rec.body.contactMap || []).map((x) => [x.ref, x.contactId]));
  const who = (ref) => (me && ref === me.ref ? self : (map.get(ref) && wallet.get(map.get(ref)) ? map.get(ref) : null));
  const actor = e.actor?.ref ? who(e.actor.ref) : (me && me.role === 'actor' ? self : null);
  const parts = (e.participants || []).slice(0, LIMITS.participants);
  const affected = parts.filter((p) => p.role === 'affected' && p.ref !== e.actor?.ref).map((p) => who(p.ref)).filter(Boolean);
  const role = me ? (ROLES.includes(me.role) ? me.role : 'witness') : (actor === self ? 'actor' : 'witness');
  return {
    actor: actor || '', action: str(e.action), objects: (e.objects || []).slice(0, LIMITS.objects).map((o) => ({ label: str(o?.label) || '-', ...(typeof o?.quantity === 'number' ? { quantity: o.quantity } : {}), ...(o?.unit ? { unit: str(o.unit, 40) } : {}) })),
    affected: [...new Set(affected)], role, occurredAt: str(e.occurredAt, 40), ...(e.approx ? { approx: true } : {}),
    stamps: [], rulings: [],
    streamRef: { provider: rec.body.providerAddress, streamId: rec.body.streamId, eventId: e.eventId, rev: e.rev },
    streamInfo: {
      kind: str(e.kind, 40) || 'other', ...(e.until ? { until: str(e.until, 40) } : {}), ...(e.summary ? { summary: str(e.summary, 1000) } : {}),
      ...(e.source && (e.source.label || e.source.url) ? { source: { label: str(e.source.label), ...(urlOk(e.source.url) && /^https:/.test(e.source.url) ? { url: e.source.url } : {}) } } : {}),
      ...(typeof e.confidence === 'number' ? { confidence: Math.max(0, Math.min(1, e.confidence)) } : {}),
      actor: { ref: str(e.actor?.ref, 100), label: str(e.actor?.label) },
      participants: parts.map((p) => ({ ref: str(p.ref, 100), label: str(p.label), ...(ROLES.includes(p.role) ? { role: p.role } : {}) })),
      objectTypes: (e.objects || []).slice(0, LIMITS.objects).map((o) => str(o?.type, 40)),
      ...(me ? { selfRef: me.ref } : {}), needsSelf: !me && parts.length > 0,
      ...extra,
    },
  };
}

// An event that can be confirmed without asking: the holder is found and the actor is known
export const resolved = (body) => !!body.actor && !body.streamInfo?.needsSelf;

function ruleFor(rec, e, body) {
  if (!resolved(body)) return null;
  return (rec.body.rules || []).find((r) => {
    const m = r.match || {};
    if (m.kind && m.kind !== (e.kind || 'other')) return false;
    if (m.actorRef && m.actorRef !== e.actor?.ref) return false;
    if (m.participantRef && !(e.participants || []).some((p) => p.ref === m.participantRef)) return false;
    return !!(m.kind || m.actorRef || m.participantRef);
  }) || null;
}

// Takes in events from a stream (20.7). Moves nothing back to the provider. Returns counts.
export async function intake(wallet, rootId, list, recipients = []) {
  const out = { added: 0, updated: 0, ignored: 0, dropped: 0, suspicious: 0, withdrawn: 0, byRule: 0, corrections: 0, paused: false };
  let rec = fresh(wallet, rootId);
  if (!rec || rec.body.paused || rec.body.leaving) { out.ignored = (list || []).length; return out; }
  const s = rec.body.descriptor.stream;
  const recips = recipients.length ? recipients : (rec.body.subscriptions || []).map((x) => x.address);
  const idx = stateIndex(wallet, { body: rec.body });
  const handled = new Map((rec.body.handled || []).map((x) => [x.eventId, x]));
  const updates = new Map((rec.body.updates || []).map((x) => [x.eventId, x]));
  const suspicious = [...(rec.body.suspicious || [])];
  let pending = pendingOf(wallet, rec).length;
  let suggestedBy = null;
  let pausedNow = false;
  for (const e of (list || []).slice(0, 1000)) {
    if (await checkEvent(e, s, recips)) { out.dropped++; continue; }
    const hash = await C.hashJson(e);
    const cur = idx.get(e.eventId);
    if (cur && e.rev < cur.rev) { out.ignored++; continue; }
    if (cur && e.rev === cur.rev) {
      if (cur.hash && cur.hash !== hash && !suspicious.some((x) => x.eventId === e.eventId && x.rev === e.rev)) { suspicious.push({ eventId: e.eventId, rev: e.rev, at: C.nowIso() }); out.suspicious++; }
      else out.ignored++;
      continue;
    }
    const state = cur?.state;
    if (state === 'pending') {
      if (e.withdrawn) {
        await wallet.withdraw(cur.eventRoot);
        handled.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: 'withdrawn', hash });
        idx.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: 'withdrawn', hash });
        pending--; out.withdrawn++;
      } else {
        const old = wallet.get(cur.eventRoot);
        const body = mapEvent(wallet, { body: rec.body }, e, { hash });
        await wallet.correct(cur.eventRoot, { ...body, status: 'suggested', suggestedBy: old.body.suggestedBy });
        idx.set(e.eventId, { ...cur, rev: e.rev, hash });
        out.updated++;
      }
      continue;
    }
    if (state === 'confirmed') {
      // the provider corrected or withdrew an event the holder confirmed: say so, never change it (20.7.2)
      updates.set(e.eventId, { eventId: e.eventId, rev: e.rev, withdrawn: !!e.withdrawn, event: e, at: C.nowIso() });
      idx.set(e.eventId, { ...cur, rev: e.rev, hash });
      handled.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: 'confirmed', hash, eventRoot: cur.eventRoot });
      out.corrections++;
      continue;
    }
    if (state === 'rejected') {
      handled.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: 'rejected', hash, ...(cur.eventRoot ? { eventRoot: cur.eventRoot } : {}) });
      idx.set(e.eventId, { ...cur, rev: e.rev, hash });
      out.ignored++;
      continue;
    }
    // new, or withdrawn earlier and offered again at a higher rev
    if (e.withdrawn) {
      handled.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: 'withdrawn', hash });
      idx.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: 'withdrawn', hash });
      out.ignored++;
      continue;
    }
    if (pending >= LIMITS.pending) { pausedNow = true; break; }
    suggestedBy = suggestedBy || await providerContact(wallet, s);
    const body = mapEvent(wallet, { body: rec.body }, e, { hash });
    const rule = ruleFor(rec, e, body);
    const id = await wallet.add('event', rule
      ? { ...body, status: 'confirmed', suggestedBy, byRule: rule.id, byRuleAt: C.nowIso() }
      : { ...body, status: 'suggested', suggestedBy }, { source: 'stream' });
    idx.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: rule ? 'confirmed' : 'pending', hash, eventRoot: id });
    handled.delete(e.eventId);
    if (rule) { out.byRule++; handled.set(e.eventId, { eventId: e.eventId, rev: e.rev, state: 'confirmed', hash, eventRoot: id }); }
    else pending++;
    out.added++;
  }
  out.paused = pausedNow;
  await patch(wallet, rootId, (b) => ({ ...b, handled: [...handled.values()], updates: [...updates.values()], suspicious: suspicious.slice(-50),
    ...(pausedNow ? { paused: true, pausedReason: 'too-many' } : {}), lastIntakeAt: C.nowIso() }));
  return out;
}

// ---- pulling and receiving ----

// Brings in what is waiting for one stream: pull over https and/or the relay inbox of this device's subscription.
// Moves the cursor only after the events are stored (20.10).
export async function refresh(wallet, rootId, keyStore) {
  const rec = fresh(wallet, rootId);
  if (!rec) return null;
  const s = rec.body.descriptor.stream;
  const total = { added: 0, updated: 0, ignored: 0, dropped: 0, suspicious: 0, withdrawn: 0, byRule: 0, corrections: 0, paused: !!rec.body.paused, receipts: 0, other: 0 };
  const add = (r) => { for (const k of Object.keys(r)) if (typeof r[k] === 'number') total[k] = (total[k] || 0) + r[k]; if (r.paused) total.paused = true; };
  const dk = await deviceKeys(wallet, rec, keyStore);
  if (s.access !== 'open' && !dk) return { ...total, noKeys: true };
  if (rec.body.leaving) { await retryLeave(wallet, rootId, keyStore).catch(() => {}); return total; }
  if (rec.body.paused) return total;
  // relay first: it holds pushed events, the subscribed reply and receipts
  if (dk && s.transport.includes('relay')) {
    const msgs = await new RelayClient(relayOf(s, rec.body.relay)).inbox(dk.ks);
    for (const m of msgs) {
      let o;
      try { o = await C.openMessage(dk.ks, m); } catch { continue; }
      if (!o.verified || o.from !== s.provider.address) continue;
      add(await handleProviderBody(wallet, rootId, o.body, dk));
    }
  }
  if (s.transport.includes('https')) {
    let cursor = fresh(wallet, rootId).body.cursor || '';
    for (let page = 0; page < 10; page++) {
      const url = s.endpoint.replace(/\/$/, '') + '/events' + (cursor ? '?after=' + encodeURIComponent(cursor) : '');
      const headers = dk ? await requestProof(s, dk.ks, { subscriptionId: dk.subscriptionId }, 'GET', url) : {};
      const { body } = await getJson(url, { headers });
      const list = [];
      for (const item of Array.isArray(body?.events) ? body.events.slice(0, 100) : []) {
        if (item?.type === 'aevri.vledger.message' && dk) {
          try {
            const o = await C.openMessage(dk.ks, item);
            if (o.from && o.from !== s.provider.address) continue;
            if (o.body?.kind === 'stream-events' && Array.isArray(o.body.events)) list.push(...o.body.events.slice(0, 100));
            else list.push(o.body);
          } catch { total.dropped++; }
        } else list.push(item);
      }
      const got = await intake(wallet, rootId, list, dk ? [dk.ks.address] : []);
      add(got);
      if (got.paused) break; // not stored: the cursor stays
      const next = typeof body?.cursor === 'string' ? body.cursor.slice(0, 500) : cursor;
      if (next !== cursor) await patch(wallet, rootId, (b) => ({ ...b, cursor: next }));
      if (!list.length || next === cursor || (fresh(wallet, rootId).body.paused)) break;
      cursor = next;
    }
  }
  return total;
}

// One message from the provider to this device's subscription
async function handleProviderBody(wallet, rootId, body, dk) {
  const rec = fresh(wallet, rootId);
  const s = rec.body.descriptor.stream;
  if (body?.kind === 'stream-events' && Array.isArray(body.events)) return intake(wallet, rootId, body.events.slice(0, 100), [dk.ks.address]);
  if (body?.type === 'aevri.vledger.stream-event') return intake(wallet, rootId, [body], [dk.ks.address]);
  if (body?.kind === 'unsubscribed') { await applyUnsubscribed(wallet, rootId, body); return { other: 1 }; }
  if (body?.kind === 'feedback-receipt') return { receipts: (await applyReceipt(wallet, body, s.provider.address)) ? 1 : 0 };
  if (body?.kind === 'subscribed' && body.descriptor) {
    try { const ch = descriptorChange(s, await verifyDescriptor(body.descriptor, rec.body)); if (ch !== 'same' && ch !== 'ignore') await offerDescriptor(wallet, rootId, body.descriptor, ch); } catch { /* ignore */ }
    return { other: 1 };
  }
  return { other: 1 };
}

// A newer descriptor: small changes are kept, changes of endpoint, relay, access or policy wait for the holder (20.2)
export async function offerDescriptor(wallet, rootId, doc, change) {
  if (change === 'auto') return patch(wallet, rootId, (b) => ({ ...b, descriptor: doc }));
  if (change === 'approve') return patch(wallet, rootId, (b) => ({ ...b, descriptorOffer: doc }));
  return null;
}
export const acceptDescriptor = (wallet, rootId) => patch(wallet, rootId, (b) => (b.descriptorOffer ? { ...b, descriptor: b.descriptorOffer, descriptorOffer: undefined } : b));
export const declineDescriptor = (wallet, rootId) => patch(wallet, rootId, (b) => ({ ...b, descriptorOffer: undefined }));

// Asks the provider to send again what the relay may have dropped (20.5)
export async function askReplay(wallet, rootId, keyStore, since) {
  const rec = fresh(wallet, rootId);
  const s = rec.body.descriptor.stream;
  const dk = await deviceKeys(wallet, rec, keyStore);
  if (!dk || !s.transport.includes('relay')) return false;
  const body = { kind: 'replay', streamId: s.streamId, ...(since ? { since } : {}) };
  await new RelayClient(relayOf(s, rec.body.relay)).send(await C.sealMessage(providerCard(s), body, dk.ks));
  return true;
}

// ---- the holder's decisions (20.6, 20.7) ----

async function markHandled(wallet, rootId, entries) {
  return patch(wallet, rootId, (b) => {
    const m = new Map((b.handled || []).map((x) => [x.eventId, x]));
    for (const x of entries) m.set(x.eventId, { ...(m.get(x.eventId) || {}), ...x });
    return { ...b, handled: [...m.values()] };
  });
}

const recOfEvent = (wallet, ev) => streamOf(wallet, ev.body.streamRef?.provider, ev.body.streamRef?.streamId);

// "Which of these is you?" (holder-identified streams): remembered for that ref; pending events are mapped again
export async function setSelf(wallet, rootId, ref) {
  await patch(wallet, rootId, (b) => ({ ...b, selfRefs: [...new Set([...(b.selfRefs || []), ref])] }));
  return remapPending(wallet, rootId);
}

// "Anna in 2dBrain is my contact Anna": the map stays in the wallet
export async function mapContact(wallet, rootId, ref, contactId) {
  await patch(wallet, rootId, (b) => ({ ...b, contactMap: [...(b.contactMap || []).filter((x) => x.ref !== ref), { ref, contactId }] }));
  return remapPending(wallet, rootId);
}

async function remapPending(wallet, rootId) {
  const rec = fresh(wallet, rootId);
  let n = 0;
  for (const ev of pendingOf(wallet, { body: rec.body })) {
    const i = ev.body.streamInfo || {};
    const e = { eventId: ev.body.streamRef.eventId, rev: ev.body.streamRef.rev, kind: i.kind, actor: i.actor, participants: (i.participants || []).map((p) => ({ ...p, ...(p.ref === i.selfRef && rec.body.descriptor.stream.identifies === 'provider' ? { you: true } : {}) })),
      action: ev.body.action, objects: ev.body.objects.map((o, k) => ({ ...o, ...(i.objectTypes?.[k] ? { type: i.objectTypes[k] } : {}) })), occurredAt: ev.body.occurredAt, approx: ev.body.approx, until: i.until, summary: i.summary, source: i.source, confidence: i.confidence };
    const body = mapEvent(wallet, { body: rec.body }, e, { hash: i.hash });
    if (C.canon(body.actor) !== C.canon(ev.body.actor) || C.canon(body.affected) !== C.canon(ev.body.affected) || body.role !== ev.body.role || !!body.streamInfo.needsSelf !== !!i.needsSelf) {
      await wallet.correct(ev.rootId, { ...ev.body, actor: body.actor, affected: body.affected, role: body.role, streamInfo: { ...i, ...(body.streamInfo.selfRef ? { selfRef: body.streamInfo.selfRef } : {}), needsSelf: body.streamInfo.needsSelf } });
      n++;
    }
  }
  return n;
}

// "I was there" / "it affects me" for an event without the holder (open streams)
export async function keepAs(wallet, evRootId, role) {
  const ev = wallet.get(evRootId);
  const self = wallet.selfContact().rootId;
  const affected = role === 'affected' ? [...new Set([...(ev.body.affected || []), self])] : ev.body.affected;
  return wallet.correct(evRootId, { ...ev.body, role, affected, streamInfo: { ...ev.body.streamInfo, needsSelf: false } });
}

export async function confirm(wallet, evRootIds) {
  const byStream = new Map();
  for (const id of evRootIds) {
    const ev = wallet.get(id);
    if (!ev || ev.body.status !== 'suggested' || !resolved(ev.body)) continue;
    await wallet.correct(id, { ...ev.body, status: 'confirmed' });
    const rec = recOfEvent(wallet, ev);
    if (rec) { if (!byStream.has(rec.rootId)) byStream.set(rec.rootId, []); byStream.get(rec.rootId).push({ eventId: ev.body.streamRef.eventId, rev: ev.body.streamRef.rev, state: 'confirmed', eventRoot: id }); }
  }
  for (const [rid, list] of byStream) await markHandled(wallet, rid, list);
  return [...byStream.values()].reduce((n, l) => n + l.length, 0);
}

export async function reject(wallet, evRootIds) {
  const byStream = new Map();
  let n = 0;
  for (const id of evRootIds) {
    const ev = wallet.get(id);
    if (!ev || ev.body.status !== 'suggested') continue;
    await wallet.correct(id, { ...ev.body, status: 'rejected' });
    n++;
    const rec = recOfEvent(wallet, ev);
    if (rec) { if (!byStream.has(rec.rootId)) byStream.set(rec.rootId, []); byStream.get(rec.rootId).push({ eventId: ev.body.streamRef.eventId, rev: ev.body.streamRef.rev, state: 'rejected', eventRoot: id }); }
  }
  for (const [rid, list] of byStream) await markHandled(wallet, rid, list);
  return n;
}

// Accept the provider's correction of a confirmed event as a correction of the holder's record (section 6)
export async function acceptUpdate(wallet, rootId, eventId) {
  const rec = fresh(wallet, rootId);
  const u = (rec.body.updates || []).find((x) => x.eventId === eventId);
  if (!u) return null;
  const h = (rec.body.handled || []).find((x) => x.eventId === eventId);
  const ev = h?.eventRoot ? wallet.get(h.eventRoot) : wallet.list('event').find((x) => x.body.streamRef?.eventId === eventId && x.body.streamRef?.streamId === rec.body.streamId);
  if (ev) {
    if (u.withdrawn) await wallet.withdraw(ev.rootId);
    else {
      const body = mapEvent(wallet, rec, u.event, { hash: await C.hashJson(u.event) });
      // the holder's own choices stay: who the actor is, role, value system
      await wallet.correct(ev.rootId, { ...ev.body, action: body.action, objects: body.objects, occurredAt: body.occurredAt, streamRef: body.streamRef, streamInfo: { ...ev.body.streamInfo, ...body.streamInfo, needsSelf: false } });
    }
  }
  await patch(wallet, rootId, (b) => ({ ...b, updates: (b.updates || []).filter((x) => x.eventId !== eventId) }));
  return ev ? ev.rootId : null;
}
export const dismissUpdate = (wallet, rootId, eventId) => patch(wallet, rootId, (b) => ({ ...b, updates: (b.updates || []).filter((x) => x.eventId !== eventId) }));

// ---- rules (20.7.4): made by the holder from an event confirmed by hand, only confirm, undo in one tap ----

export async function addRule(wallet, rootId, match, label = '') {
  const id = C.uuid7();
  await patch(wallet, rootId, (b) => ({ ...b, rules: [...(b.rules || []), { id, match, label: str(label), createdAt: C.nowIso() }] }));
  return id;
}

export function ruleCounts(wallet, rec, day = new Date().toISOString().slice(0, 10)) {
  const out = {};
  for (const ev of wallet.list('event')) {
    if (!ev.body.byRule || ev.body.status !== 'confirmed' || ev.body.streamRef?.streamId !== rec.body.streamId) continue;
    const o = out[ev.body.byRule] || (out[ev.body.byRule] = { total: 0, today: 0 });
    o.total++;
    if (String(ev.body.byRuleAt).slice(0, 10) === day) o.today++;
  }
  return out;
}

// Undo a rule: everything it confirmed goes back to the review queue, and the rule is removed
export async function undoRule(wallet, rootId, ruleId) {
  let n = 0;
  const back = [];
  for (const ev of wallet.list('event')) {
    if (ev.body.byRule !== ruleId || ev.body.status !== 'confirmed') continue;
    const { byRule, byRuleAt, ...rest } = ev.body;
    await wallet.correct(ev.rootId, { ...rest, status: 'suggested' });
    back.push(ev.body.streamRef.eventId);
    n++;
  }
  await patch(wallet, rootId, (b) => ({ ...b, rules: (b.rules || []).filter((r) => r.id !== ruleId), handled: (b.handled || []).filter((x) => !back.includes(x.eventId)) }));
  return n;
}

// ---- pause, leave, forget (20.8) ----

export const pause = (wallet, rootId, paused = true) => patch(wallet, rootId, (b) => ({ ...b, paused, ...(paused ? {} : { pausedReason: undefined }) }));

export async function leave(wallet, rootId, keyStore) {
  await patch(wallet, rootId, (b) => ({ ...b, leaving: true, leaveAskedAt: C.nowIso() }));
  return retryLeave(wallet, rootId, keyStore);
}

// Returns true when the provider's signed receipt arrived
export async function retryLeave(wallet, rootId, keyStore) {
  const rec = fresh(wallet, rootId);
  const s = rec.body.descriptor.stream;
  if (s.access === 'open') { await applyUnsubscribed(wallet, rootId, null); return true; }
  const dk = await deviceKeys(wallet, rec, keyStore);
  if (!dk) return false;
  if (s.transport.includes('https')) {
    const url = s.endpoint.replace(/\/$/, '') + '/subscriptions/' + encodeURIComponent(dk.subscriptionId);
    const { body } = await getJson(url, { method: 'DELETE', headers: await requestProof(s, dk.ks, { subscriptionId: dk.subscriptionId }, 'DELETE', url) });
    if (body?.kind === 'unsubscribed') return applyUnsubscribed(wallet, rootId, body, keyStore);
    return false;
  }
  const rc = new RelayClient(relayOf(s, rec.body.relay));
  await rc.send(await C.sealMessage(providerCard(s), { kind: 'unsubscribe', streamId: s.streamId, subscriptionId: dk.subscriptionId }, dk.ks));
  for (const m of await rc.inbox(dk.ks)) {
    try {
      const o = await C.openMessage(dk.ks, m);
      if (o.verified && o.from === s.provider.address && o.body?.kind === 'unsubscribed') return applyUnsubscribed(wallet, rootId, o.body, keyStore);
      if (o.verified && o.from === s.provider.address) await handleProviderBody(wallet, rootId, o.body, dk).catch(() => {});
    } catch { /* skip */ }
  }
  return false;
}

export async function verifyUnsubscribed(body, s) {
  if (!body || body.kind !== 'unsubscribed' || body.streamId !== s.streamId || typeof body.sig !== 'string') return false;
  const { sig, ...rest } = body;
  return C.verify(C.keyOfAddress(s.provider.address), C.te.encode(C.canon(rest)), sig).catch(() => false);
}

async function applyUnsubscribed(wallet, rootId, body, keyStore) {
  const rec = fresh(wallet, rootId);
  if (!rec) return false;
  if (body && !(await verifyUnsubscribed(body, rec.body.descriptor.stream))) return false;
  await patch(wallet, rootId, (b) => ({ ...b, leaving: false, left: { at: C.nowIso(), ...(body ? { receipt: body } : {}) }, paused: true }));
  if (keyStore && body) for (const sub of rec.body.subscriptions || []) if (sub.subscriptionId === body.subscriptionId) await keyStore.remove(`${wallet.id}|${sub.address}`).catch(() => {});
  return true;
}

// Forget at once: the stream record goes, this device's keys go; confirmed events stay
export async function forget(wallet, rootId, keyStore) {
  const rec = fresh(wallet, rootId);
  if (!rec) return;
  for (const sub of rec.body.subscriptions || []) await keyStore.remove(`${wallet.id}|${sub.address}`).catch(() => {});
  for (const ev of pendingOf(wallet, rec)) await wallet.withdraw(ev.rootId);
  await wallet.withdraw(rootId);
}

// ---- feedback to a stream (20.11) ----

// The sender forms a stream accepts, the most private first
export function senderForms(s, hasKeys) {
  const fb = s.feedback;
  if (!fb) return [];
  return ['anonymous', 'subscriber', 'named'].filter((x) => fb.senders.includes(x) && (x !== 'subscriber' || hasKeys));
}

// What the stream learns about the sender (20.13): 'anyone', 'checked' (an attestation, not named) or 'named'
export const senderLevel = (s, sender) => (sender === 'named' ? 'named' : s.feedback?.requires ? 'checked' : (sender === 'subscriber' ? 'subscriber' : 'anyone'));

// Which `publish` values an item may carry under the stream's policy (and the sender form)
export function publishChoices(s, sender) {
  const p = s.feedback?.publishes;
  const all = p === 'sender-choice' ? ['no', 'anonymous', 'named'] : [p];
  return all.filter((x) => x && (x !== 'named' || sender === 'named'));
}

// A card of the provider that disagrees with the descriptor blocks sending (20.11)
export function policyConflict(rec) {
  const card = rec.body.card?.card;
  const fb = rec.body.descriptor.stream.feedback;
  return !!(card && fb && card.storage?.publishes && card.storage.publishes !== fb.publishes);
}

// Builds the exact item that will go, without sending. `fields`: {type, aboutEventRootId?, event?, role?, assessment?,
// publish, sender}. Returns {item, signer, store} where store is what the wallet keeps to follow the item.
export async function buildFeedback(wallet, rootId, fields, keyStore) {
  const rec = fresh(wallet, rootId);
  const s = rec.body.descriptor.stream;
  const fb = s.feedback;
  if (!fb) throw fail('no-feedback');
  if (policyConflict(rec)) throw fail('policy-conflict');
  if (!fb.accepts.includes(fields.type)) throw fail('not-accepted');
  if (!fb.senders.includes(fields.sender)) throw fail('sender-not-accepted');
  if (!publishChoices(s, fields.sender).includes(fields.publish)) throw fail('publish-not-allowed');
  const item = { kind: 'stream-feedback', version: 1, feedbackId: C.uuid7(), providerAddress: s.provider.address, streamId: s.streamId, descriptorRev: s.descriptorRev, type: fields.type };
  if (fields.type !== 'event') {
    const ev = wallet.get(fields.aboutEventRootId);
    const ref = ev?.body.streamRef;
    if (!ref || ref.streamId !== s.streamId || ref.provider !== s.provider.address) throw fail('no-event');
    item.about = { eventId: ref.eventId, rev: ref.rev };
  } else {
    const e = fields.event || {};
    if (!str(e.action)) throw fail('no-event');
    item.event = { action: str(e.action), ...(e.objects?.length ? { objects: e.objects.slice(0, 100).map((o) => ({ label: str(o.label || o) })) } : {}), ...(e.occurredAt ? { occurredAt: str(e.occurredAt, 40) } : {}), ...(e.place ? { place: str(e.place) } : {}) };
  }
  if (ROLES.includes(fields.role)) item.role = fields.role;
  if (fields.assessment && (fields.type === 'assessment' || fields.type === 'event')) {
    const a = fields.assessment;
    const out = { phase: a.phase === 'retro' ? 'retro' : 'realized' };
    if (REACTIONS.includes(a.reaction)) out.reaction = a.reaction;
    if (a.words) out.words = String(a.words).slice(0, 2000);
    if (a.gained?.length) out.gained = a.gained.slice(0, 20).map((x) => str(x));
    if (a.lost?.length) out.lost = a.lost.slice(0, 20).map((x) => str(x));
    if (['above-plan', 'as-planned', 'below-plan', 'harm', 'unknown'].includes(a.planGap)) out.planGap = a.planGap;
    if (typeof a.v === 'number' && Number.isFinite(a.v)) out.v = a.v;
    if (typeof a.spentV === 'number' && a.spentV >= 0) out.spentV = a.spentV;
    item.assessment = out;
  } else if (fields.type === 'assessment') throw fail('no-assessment');
  item.publish = fields.publish;
  item.sender = fields.sender;
  const reply = await C.newExchangeKey();
  let signer, store;
  if (fields.sender === 'anonymous') {
    const id = await C.newIdentity();
    signer = { address: C.addressOf(id.publicKey), signer: id.privateKey };
    store = { keyRef: 'item', key: { x: id.publicKey.x, pkcs8: C.b64u(id.pkcs8), enc: reply.privateJwk, encPub: reply.publicJwk } };
  } else if (fields.sender === 'subscriber') {
    // receipts come with the stream's own messages to this subscription
    const dk = await deviceKeys(wallet, rec, keyStore);
    if (!dk) throw fail('no-keys');
    signer = dk.ks;
    store = { keyRef: 'subscription' };
  } else {
    signer = wallet.session;
    item.card = await wallet.card();
    // receipts to a named item come to the wallet's own address, encrypted to its own key, like any message
    store = { keyRef: 'identity' };
  }
  item.key = signer.address;
  const req = s.feedback.requires;
  if (req && fields.sender !== 'named') {
    // an attestation about this item's key (or the subscription key), for this stream only, covered by the signature
    const audience = { providerAddress: s.provider.address, streamId: s.streamId };
    let doc = fields.sender === 'subscriber' ? accessAttestation(rec, signer.address)?.doc : null;
    if (doc && await checkAttestation(doc, { ...req, subject: signer.address, audience })) doc = null;
    if (!doc) {
      if (!fields.attest) throw fail('needs-attestation');
      doc = await fields.attest(signer, req, audience);
    }
    const bad = await checkAttestation(doc, { ...req, subject: signer.address, audience });
    if (bad) throw fail('attestation-' + bad);
    item.attestations = [doc];
  }
  item.replyEncKey = fields.sender === 'named' ? wallet.session.exchangePublicJwk : fields.sender === 'subscriber' ? signer.exchangePublicJwk : reply.publicJwk;
  item.sentAt = C.nowIso();
  item.sig = await C.sign(signer.signer, C.te.encode(C.canon(item)));
  if (bytes(item) > LIMITS.event) throw fail('too-large');
  return { item, signer, store };
}

// Sends a built item. Keeps a message-out record with the item and its key (encrypted inside the wallet).
export async function sendFeedback(wallet, rootId, built, { aboutEventRootId, keyStore } = {}) {
  const rec = fresh(wallet, rootId);
  const s = rec.body.descriptor.stream;
  const { item, store } = built;
  const msg = await C.sealMessage(providerCard(s), item, null);
  const itemHash = await C.hashJson(item);
  const outId = await wallet.add('message-out', { to: s.provider.address, kind: 'stream-feedback', sentAt: item.sentAt, envelopeDigest: await C.messageDigest(msg),
    ...(aboutEventRootId ? { about: aboutEventRootId } : {}),
    feedback: { streamId: s.streamId, feedbackId: item.feedbackId, type: item.type, sender: item.sender, publish: item.publish, itemHash, item, key: item.key, ...store, status: 'sending', statusRev: 0, receipts: [] } }, { source: 'stream' });
  await deliverToProvider(wallet, rec, msg, outId, keyStore);
  return outId;
}

async function deliverToProvider(wallet, rec, msg, outId, keyStore) {
  const s = rec.body.descriptor.stream;
  if (s.transport.includes('https')) {
    const { body } = await getJson(s.endpoint.replace(/\/$/, '') + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
    if (outId) await setFeedbackStatus(wallet, outId, (f) => (f.status === 'sending' ? { ...f, status: 'sent' } : f));
    if (body?.type === 'aevri.vledger.message' && outId) await receiveForItem(wallet, outId, [body], await itemSession(wallet, wallet.get(outId), keyStore));
    return;
  }
  await new RelayClient(relayOf(s, rec.body.relay)).send(msg);
  if (outId) await setFeedbackStatus(wallet, outId, (f) => (f.status === 'sending' ? { ...f, status: 'sent' } : f));
}

async function setFeedbackStatus(wallet, outId, fn) {
  const cur = wallet.get(outId);
  if (!cur) return;
  const f = fn({ ...cur.body.feedback });
  if (C.canon(f) !== C.canon(cur.body.feedback)) await wallet.correct(outId, { ...cur.body, feedback: f });
}

export const feedbackItems = (wallet, streamId) => wallet.list('message-out').filter((m) => m.body.kind === 'stream-feedback' && (!streamId || m.body.feedback?.streamId === streamId));

async function itemSession(wallet, out, keyStore) {
  const f = out.body.feedback;
  if (f.keyRef === 'identity') return wallet.session;
  if (f.keyRef === 'item') return itemKeySession(f.key);
  return keyStore ? loadKeys(wallet, f.item.key, keyStore) : null;
}

// Verifies a receipt and applies it to the item it is about. Returns true when it changed something.
export async function applyReceipt(wallet, r, providerAddress) {
  if (!r || r.kind !== 'feedback-receipt' || r.providerAddress !== providerAddress || !Number.isInteger(r.statusRev) || typeof r.sig !== 'string') return false;
  const out = feedbackItems(wallet).find((m) => m.body.feedback.feedbackId === r.feedbackId && m.body.to === providerAddress && m.body.feedback.streamId === r.streamId);
  if (!out) return false;
  const { sig, ...rest } = r;
  if (!(await C.verify(C.keyOfAddress(providerAddress), C.te.encode(C.canon(rest)), sig).catch(() => false))) return false;
  if (r.itemHash !== out.body.feedback.itemHash) return false;
  const f = out.body.feedback;
  if (r.statusRev <= (f.statusRev || 0)) return false;
  if (f.status === 'withdrawn' && r.status !== 'withdrawn') return false; // withdrawal is final
  await wallet.correct(out.rootId, { ...out.body, feedback: { ...f, status: r.status, statusRev: r.statusRev, ...(r.url && urlOk(r.url) ? { url: r.url } : {}), ...(r.reason ? { reason: str(r.reason, 2000) } : {}), receipts: [...(f.receipts || []), r].slice(-20) } });
  return true;
}

async function receiveForItem(wallet, outId, msgs, session) {
  const out = wallet.get(outId);
  if (!session) return 0;
  let n = 0;
  for (const m of msgs) {
    try {
      const o = await C.openMessage(session, m);
      if (o.body?.kind === 'feedback-receipt' && await applyReceipt(wallet, o.body, out.body.to)) n++;
    } catch { /* skip */ }
  }
  return n;
}

async function signedRequest(kind, f, ses) {
  const body = { kind, providerAddress: f.item.providerAddress, streamId: f.streamId, feedbackId: f.feedbackId, requestId: C.uuid7() };
  return { ...body, sig: await C.sign(ses.signer, C.te.encode(C.canon(body))) };
}

// Asks the provider for the status of an item, or withdraws it (final, may be repeated). Fetches receipts.
export async function feedbackRequest(wallet, outId, kind, keyStore) {
  const out = wallet.get(outId);
  const f = out.body.feedback;
  const rec = streamOf(wallet, out.body.to, f.streamId);
  if (!rec) throw fail('no-stream');
  const ses = await itemSession(wallet, out, keyStore);
  if (!ses) throw fail('no-keys');
  if (kind === 'feedback-withdraw') await setFeedbackStatus(wallet, outId, (x) => ({ ...x, withdrawAskedAt: C.nowIso() }));
  const s = rec.body.descriptor.stream;
  const msg = await C.sealMessage(providerCard(s), await signedRequest(kind, f, ses), null);
  if (s.transport.includes('https')) {
    const { body } = await getJson(s.endpoint.replace(/\/$/, '') + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
    if (body?.type === 'aevri.vledger.message') await receiveForItem(wallet, outId, [body], ses);
  } else await new RelayClient(relayOf(s, rec.body.relay)).send(msg);
  return checkReceipts(wallet, outId, keyStore);
}

// Receipts waiting at the relay for an item's key (anonymous and subscriber items; named items come to the inbox)
export async function checkReceipts(wallet, outId, keyStore) {
  const out = wallet.get(outId);
  const f = out.body.feedback;
  if (f.keyRef === 'identity') { await wallet.checkInbox().catch(() => {}); return wallet.get(outId).body.feedback.status; }
  const rec = streamOf(wallet, out.body.to, f.streamId);
  const s = rec?.body.descriptor.stream;
  const ses = await itemSession(wallet, out, keyStore);
  if (!s || !ses || !s.transport.includes('relay')) return f.status;
  if (f.keyRef === 'subscription') { await refresh(wallet, rec.rootId, keyStore).catch(() => {}); return wallet.get(outId).body.feedback.status; }
  await receiveForItem(wallet, outId, await new RelayClient(relayOf(s, rec.body.relay)).inbox(ses), ses);
  return wallet.get(outId).body.feedback.status;
}
