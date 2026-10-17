// aevri.vledger 1.0 reference: canonical JSON, keys, encryption, record chain, receipts, arbiter messages.
// Plain ES module, Web Crypto only, no dependencies. See ../SPEC.md (sections in comments).

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export const FORMAT = 'aevri.vledger';
export const VERSION = '1.0';
export const PBKDF2_ITERATIONS = 600000;

// ---- encoding (SPEC 2) ----

export function b64u(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// RFC 8785 (JCS). ECMAScript number and string serialisation already match the RFC.
export function canon(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('JCS: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

export async function hashJson(v) {
  return 'sha256:' + hex(await sha256(te.encode(canon(v))));
}

export async function hashBytes(bytes) {
  return 'sha256:' + hex(await sha256(bytes));
}

export function uuid7(ms = Date.now()) {
  const b = rand(16);
  let t = BigInt(ms);
  for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- AES-GCM with bound AAD (SPEC 4.2) ----

const aad = (purpose, walletId, id) => te.encode(`aevri.vledger/1|${purpose}|${walletId}|${id}`);

async function aesKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(rawKey, plain, purpose, walletId, id) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(purpose, walletId, id) }, await aesKey(rawKey), plain);
  return { iv: b64u(iv), ct: b64u(ct) };
}

export async function open(rawKey, wrap, purpose, walletId, id) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(wrap.iv), additionalData: aad(purpose, walletId, id) }, await aesKey(rawKey), unb64u(wrap.ct));
  return new Uint8Array(pt);
}

// ---- KDF (SPEC 4.3) ----

export async function deriveKek(secret, kdf) {
  if (kdf.name !== 'PBKDF2') throw new Error('KDF not supported by this reference: ' + kdf.name);
  const base = await subtle.importKey('raw', te.encode(secret.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(kdf.salt), iterations: kdf.iterations }, base, 256);
  return new Uint8Array(bits);
}

export function newKdf(iterations = PBKDF2_ITERATIONS) {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64u(rand(16)) };
}

// ---- signatures (SPEC 2, 9.2) ----

export async function newIdentity() {
  const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = { alg: 'Ed25519', x: b64u(await subtle.exportKey('raw', kp.publicKey)) };
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  return { publicKey: pub, privateKey: kp.privateKey, pkcs8 };
}

export async function importSigner(pkcs8) {
  return subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

export async function sign(privateKey, bytes) {
  return b64u(await subtle.sign({ name: 'Ed25519' }, privateKey, bytes));
}

export async function verify(pub, bytes, sig) {
  if (pub.alg !== 'Ed25519') throw new Error('reference verifies Ed25519 only');
  const key = await subtle.importKey('raw', unb64u(pub.x), { name: 'Ed25519' }, false, ['verify']);
  return subtle.verify({ name: 'Ed25519' }, key, unb64u(sig), bytes);
}

const digestBytes = (d) => {
  const h = d.slice(7);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const thumbprint = (pub) => hashJson(pub);

// ---- wallet (SPEC 3-6) ----

// Returns { doc, session } where session holds the unwrapped secrets in memory only.
export async function createWallet(passphrase, { iterations, createdAt } = {}) {
  const walletId = uuid7();
  const created = createdAt || nowIso();
  const dek = rand(32);
  const kdf = newKdf(iterations);
  const kek = await deriveKek(passphrase, kdf);
  const id = await newIdentity();
  const ex = await newExchangeKey();
  const doc = {
    format: FORMAT, version: VERSION, walletId, createdAt: created,
    keyring: {
      revision: 1,
      slots: [{ id: 's1', kind: 'passphrase', kdf, wrap: await seal(kek, dek, 'slot', walletId, 's1') }],
      identity: { publicKey: id.publicKey, wrap: await seal(dek, id.pkcs8, 'identity', walletId, 'identity') },
      exchange: { publicJwk: ex.publicJwk, wrap: await seal(dek, te.encode(JSON.stringify(ex.privateJwk)), 'exchange', walletId, 'exchange') },
    },
    records: [],
    extensions: {},
  };
  return { doc, session: { walletId, dek, signer: id.privateKey, publicKey: id.publicKey, address: addressOf(id.publicKey), exchangePrivate: await importEcdhPrivate(ex.privateJwk), exchangePublicJwk: ex.publicJwk } };
}

export async function unlockWithPassphrase(doc, passphrase) {
  for (const slot of doc.keyring.slots.filter((s) => s.kind === 'passphrase' || s.kind === 'recovery-code')) {
    try {
      const kek = await deriveKek(passphrase, slot.kdf);
      const dek = await open(kek, slot.wrap, 'slot', doc.walletId, slot.id);
      return sessionFromDek(doc, dek);
    } catch { /* wrong secret for this slot */ }
  }
  throw new Error('wrong passphrase');
}

async function sessionFromDek(doc, dek) {
  const pkcs8 = await open(dek, doc.keyring.identity.wrap, 'identity', doc.walletId, 'identity');
  const s = { walletId: doc.walletId, dek, signer: await importSigner(pkcs8), publicKey: doc.keyring.identity.publicKey, address: addressOf(doc.keyring.identity.publicKey) };
  if (doc.keyring.exchange) {
    const jwk = JSON.parse(td.decode(await open(dek, doc.keyring.exchange.wrap, 'exchange', doc.walletId, 'exchange')));
    s.exchangePrivate = await importEcdhPrivate(jwk);
    s.exchangePublicJwk = doc.keyring.exchange.publicJwk;
  }
  return s;
}

// Provider recovery slot (SPEC 4.4). providerPublicJwk: ECDH P-256 public JWK.
async function recoveryKey(sharedBits, walletId, keyId) {
  const base = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(`aevri.vledger/1|recovery|${walletId}|${keyId}`) }, base, 256);
  return new Uint8Array(bits);
}

export async function addProviderRecoverySlot(doc, session, { providerId, keyId, providerPublicJwk, slotId = 'r1' }) {
  const pub = await subtle.importKey('jwk', providerPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256));
  const wk = await recoveryKey(shared, doc.walletId, keyId);
  const { kty, crv, x, y } = await subtle.exportKey('jwk', eph.publicKey);
  doc.keyring.slots.push({ id: slotId, kind: 'provider-recovery', providerId, keyId, epk: { kty, crv, x, y }, wrap: await seal(wk, session.dek, 'slot', doc.walletId, slotId) });
  doc.keyring.revision += 1;
}

export async function recoverWithProviderKey(doc, slotId, providerPrivateJwk) {
  const slot = doc.keyring.slots.find((s) => s.id === slotId && s.kind === 'provider-recovery');
  const priv = await subtle.importKey('jwk', providerPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epk = await subtle.importKey('jwk', slot.epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256));
  const wk = await recoveryKey(shared, doc.walletId, slot.keyId);
  return sessionFromDek(doc, await open(wk, slot.wrap, 'slot', doc.walletId, slot.id));
}

export const linkOf = (r) => ({ id: r.id, seq: r.seq, prevHash: r.prevHash, ctHash: r.ctHash });

async function nextPrevHash(doc) {
  const last = doc.records[doc.records.length - 1];
  return last ? hashJson(linkOf(last)) : hashJson({ walletId: doc.walletId, createdAt: doc.createdAt });
}

export async function addRecord(doc, session, payload, id = uuid7()) {
  const rk = rand(32);
  const sealed = await seal(rk, te.encode(canon(payload)), 'payload', doc.walletId, id);
  const env = {
    id, seq: doc.records.length + 1, prevHash: await nextPrevHash(doc),
    rk: await seal(session.dek, rk, 'record', doc.walletId, id),
    iv: sealed.iv, ct: sealed.ct, ctHash: await hashBytes(unb64u(sealed.ct)),
  };
  doc.records.push(env);
  return env;
}

export async function readRecord(doc, session, env) {
  if (env.erased) return null;
  const rk = await open(session.dek, env.rk, 'record', doc.walletId, env.id);
  return JSON.parse(td.decode(await open(rk, { iv: env.iv, ct: env.ct }, 'payload', doc.walletId, env.id)));
}

export function erase(doc, id, at = nowIso()) {
  const i = doc.records.findIndex((r) => r.id === id);
  const r = doc.records[i];
  doc.records[i] = { id: r.id, seq: r.seq, prevHash: r.prevHash, ctHash: r.ctHash, erased: at };
}

// Returns a list of problems; an empty list means the chain is intact (SPEC 5.1, 12.3).
export async function verifyChain(doc) {
  const problems = [];
  let prev = await hashJson({ walletId: doc.walletId, createdAt: doc.createdAt });
  for (let i = 0; i < doc.records.length; i++) {
    const r = doc.records[i];
    if (r.seq !== i + 1) problems.push(`record ${r.id}: seq ${r.seq}, expected ${i + 1}`);
    if (r.prevHash !== prev) problems.push(`record ${r.id}: prevHash does not match`);
    if (!r.erased && (await hashBytes(unb64u(r.ct))) !== r.ctHash) problems.push(`record ${r.id}: ctHash does not match`);
    prev = await hashJson(linkOf(r));
  }
  return problems;
}

// ---- receipts and arbiter (SPEC 9, 10) ----

export async function elementDigest(el) {
  return hashJson({ salt: el.salt, label: el.label, quantity: el.quantity ?? null, unit: el.unit ?? null, note: el.note ?? null });
}

export const actionDigest = (a) => hashJson({ salt: a.salt, text: a.text });
export const objectDigest = elementDigest;

export const receiptDigest = (receipt) => hashJson(receipt);

export async function signReceipt(bundle, party, session) {
  const d = digestBytes(await receiptDigest(bundle.receipt));
  bundle.signatures = bundle.signatures.filter((s) => s.party !== party);
  bundle.signatures.push({ party, alg: 'Ed25519', sig: await sign(session.signer, d) });
  bundle.signatures.sort((a, b) => a.party - b.party);
  return bundle;
}

// matched = every party signed the same digest with its own key.
export async function receiptStatus(bundle) {
  const d = digestBytes(await receiptDigest(bundle.receipt));
  const ok = [];
  for (const s of bundle.signatures) {
    const p = bundle.receipt.parties[s.party];
    if (p && (await verify(p.key, d, s.sig))) ok.push(s.party);
  }
  const all = bundle.receipt.parties.every((_, i) => ok.includes(i));
  return { matched: all, validSignatures: ok, binding: all && bundle.receipt.mandate.mode === 'binding' };
}

// Arbiter side: stamp after checking every signature (SPEC 10).
export async function makeStamp(arbiter, request, receivedAt = nowIso()) {
  const d = digestBytes(request.receiptDigest);
  for (const s of request.signatures) {
    if (!(await verify(request.keys[s.party], d, s.sig))) throw new Error('bad signature for party ' + s.party);
  }
  const stamp = { type: 'aevri.vledger.stamp', receiptDigest: request.receiptDigest, parties: await Promise.all(request.keys.map(thumbprint)), receivedAt, arbiter: arbiter.ref };
  stamp.sig = await sign(arbiter.signer, te.encode(canon(stamp)));
  return stamp;
}

export async function makeRuling(arbiter, fields) {
  const ruling = { type: 'aevri.vledger.ruling', ...fields, arbiter: arbiter.ref };
  ruling.sig = await sign(arbiter.signer, te.encode(canon(ruling)));
  return ruling;
}

// Verify a stamp, ruling or profile signed over canon(object without sig).
export async function verifySigned(obj, pub) {
  const { sig, ...rest } = obj;
  return verify(pub, te.encode(canon(rest)), sig);
}

export { te, td };

// ---- addresses, cards, messages (SPEC 3, 11) ----

const pubJwk = ({ kty, crv, x, y }) => ({ kty, crv, x, y });

export async function newExchangeKey() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { publicJwk: pubJwk(await subtle.exportKey('jwk', kp.publicKey)), privateJwk: await subtle.exportKey('jwk', kp.privateKey) };
}

export function importEcdhPrivate(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

export const addressOf = (pub) => 'vw1:' + pub.x;
export const keyOfAddress = (addr) => ({ alg: 'Ed25519', x: addr.slice(4) });
const ADDR = /vw1:[A-Za-z0-9_-]{43}/;

// Accepts a bare address or the link form https://aeilus.institute/w/#vw1:...?n=..&k=..
export function parseAddress(text) {
  const m = String(text || '').match(ADDR);
  if (!m) return null;
  const out = { address: m[0] };
  const q = String(text).slice(m.index + m[0].length);
  if (q.startsWith('?')) {
    const p = new URLSearchParams(q.slice(1));
    if (p.get('n')) out.name = p.get('n').slice(0, 300);
    if (p.get('k')) out.kind = p.get('k');
  }
  return out;
}

export function addressLink(address, { name, kind } = {}) {
  const p = new URLSearchParams();
  if (name) p.set('n', name);
  if (kind) p.set('k', kind);
  const qs = p.toString();
  return 'https://aeilus.institute/w/#' + address + (qs ? '?' + qs : '');
}

export async function makeCard(session, { kind = 'person', name, inbox, registryUrl, storage = { stores: false, publishes: 'no' }, updatedAt = nowIso() } = {}) {
  const card = { type: 'aevri.vledger.card', version: 1, address: session.address, kind, encKey: session.exchangePublicJwk, storage, updatedAt };
  if (name) card.name = name;
  if (inbox) card.inbox = inbox;
  if (registryUrl) card.registryUrl = registryUrl;
  return { card, sig: await sign(session.signer, te.encode(canon(card))) };
}

export const verifyCard = (doc) => verify(keyOfAddress(doc.card.address), te.encode(canon(doc.card)), doc.sig);

async function messageKey(sharedBits, id, to) {
  const base = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(`aevri.vledger/1|message|${id}|${to}`) }, base, 256));
}

// Encrypt `body` for the card's owner. `from` is a session (signed) or null (anonymous).
export async function sealMessage(toCard, body, from = null, { id = uuid7(), sentAt = nowIso() } = {}) {
  const to = toCard.card.address;
  const recipient = await subtle.importKey('jwk', toCard.card.encKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await messageKey(new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256)), id, to);
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`aevri.vledger/1|message|${id}|${to}`) }, await aesKey(key), te.encode(canon(body)));
  const msg = { type: 'aevri.vledger.message', version: 1, id, to, sentAt, epk: pubJwk(await subtle.exportKey('jwk', eph.publicKey)), iv: b64u(iv), ct: b64u(ct) };
  if (from) {
    msg.from = from.address;
    msg.sig = await sign(from.signer, te.encode(canon(msg)));
  }
  return msg;
}

// Returns { body, from, verified }. Throws if the message is not for this session or does not decrypt.
export async function openMessage(session, msg) {
  if (msg.to !== session.address) throw new Error('message is for another wallet');
  const epk = await subtle.importKey('jwk', msg.epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await messageKey(new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: epk }, session.exchangePrivate, 256)), msg.id, msg.to);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(msg.iv), additionalData: te.encode(`aevri.vledger/1|message|${msg.id}|${msg.to}`) }, await aesKey(key), unb64u(msg.ct));
  let verified = false;
  if (msg.from && msg.sig) {
    const { sig, ...rest } = msg;
    verified = await verify(keyOfAddress(msg.from), te.encode(canon(rest)), sig);
  }
  return { body: JSON.parse(td.decode(pt)), from: msg.from || null, verified };
}

export const messageDigest = (msg) => hashJson(msg);

// Request blocking (SPEC 11). settings.requests = {blockAll, blockSystems[], blockContacts[]};
// contacts: [{rootId, body:{address}}], systems: [{rootId, body:{title, registryUrl}}]
export function requestBlocked(settings, body, from, contacts = [], systems = []) {
  const r = (settings && settings.requests) || {};
  if (r.blockAll) return true;
  if (from && (r.blockContacts || []).some((id) => contacts.find((c) => c.rootId === id)?.body.address === from)) return true;
  const named = (r.blockSystems || []).map((id) => systems.find((x) => x.rootId === id)).filter(Boolean);
  return named.some((x) => (body.systemRegistryUrl && x.body.registryUrl === body.systemRegistryUrl)
    || (body.system && x.body.title.toLowerCase() === String(body.system).toLowerCase()));
}

// A session from a DEK obtained by provider recovery (SPEC 4.4); the caller must then set a new passphrase slot.
export function unlockWithDek(doc, dek) { return sessionFromDek(doc, dek); }

// Rebuild a wallet document from a provider's keyring and record set, in the provider's order (SPEC 8).
export async function rebuildDoc(walletId, createdAt, keyring, items) {
  const doc = { format: FORMAT, version: VERSION, walletId, createdAt, keyring, records: [], extensions: {} };
  for (const it of items) {
    const prevHash = doc.records.length ? await hashJson(linkOf(doc.records[doc.records.length - 1])) : await hashJson({ walletId, createdAt });
    doc.records.push({ ...it, seq: doc.records.length + 1, prevHash });
  }
  return doc;
}
