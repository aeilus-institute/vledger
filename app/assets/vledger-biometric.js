// Unlock on this device with its biometrics (SPEC 18, owner 2026-10-17). A passkey made on this device with the
// WebAuthn PRF extension gives, after the platform checks fingerprint, face or PIN, a secret that never leaves the
// device. The wallet's data key is wrapped with a key derived from that secret and kept on this device only, next to
// the wallet file and never inside it, so copies at providers cannot use it. The passphrase stays the master key.
// Where a browser has no PRF, nothing is enabled and the wallet opens with the passphrase as before.
import * as C from './vledger-crypto.js';

const te = new TextEncoder();
const b64u = (b) => C.b64u(new Uint8Array(b));
const ub64 = (s) => C.unb64u(s);

export function available() {
  return !!(globalThis.isSecureContext && globalThis.PublicKeyCredential && globalThis.navigator?.credentials);
}

const info = (walletId, credentialId) => `aevri.vledger/1|device-unlock|${walletId}|${credentialId}`;

async function kekFrom(prfOutput, walletId, credentialId) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info(walletId, credentialId)) }, base, 256));
}

async function evaluate(auth, credentialId, salt, rpId) {
  const cred = await auth.get({ publicKey: { challenge: C.rand(32), rpId, allowCredentials: [{ type: 'public-key', id: ub64(credentialId) }],
    userVerification: 'required', timeout: 60000, extensions: { prf: { eval: { first: ub64(salt) } } } } });
  const first = cred?.getClientExtensionResults?.()?.prf?.results?.first;
  if (!first) throw Object.assign(new Error('this device gave no key (no PRF)'), { code: 'no-prf' });
  return new Uint8Array(first);
}

// Makes a passkey for this wallet on this device and wraps the data key with it. Returns the record to keep locally.
export async function enroll(session, { label = 'Value Wallet', rpId = location.hostname, auth = navigator.credentials } = {}) {
  const salt = b64u(C.rand(32));
  const cred = await auth.create({ publicKey: {
    rp: { name: 'Value Wallet', id: rpId }, user: { id: C.rand(16), name: label, displayName: label }, challenge: C.rand(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    timeout: 60000, extensions: { prf: { eval: { first: ub64(salt) } } } } });
  const ext = cred?.getClientExtensionResults?.()?.prf;
  if (!ext || ext.enabled === false) throw Object.assign(new Error('this browser or device has no PRF'), { code: 'no-prf' });
  const credentialId = b64u(cred.rawId);
  // some platforms give the PRF result at creation, others only on use
  const prf = ext.results?.first ? new Uint8Array(ext.results.first) : await evaluate(auth, credentialId, salt, rpId);
  const kek = await kekFrom(prf, session.walletId, credentialId);
  return { walletId: session.walletId, credentialId, salt, rpId, wrap: await C.seal(kek, session.dek, 'device-unlock', session.walletId, credentialId), createdAt: C.nowIso() };
}

// Asks the device for the key (fingerprint, face or PIN) and returns the wallet's data key.
export async function unlockKey(rec, { auth = navigator.credentials } = {}) {
  const prf = await evaluate(auth, rec.credentialId, rec.salt, rec.rpId);
  const kek = await kekFrom(prf, rec.walletId, rec.credentialId);
  return C.open(kek, rec.wrap, 'device-unlock', rec.walletId, rec.credentialId);
}
