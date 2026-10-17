// Value Wallet L2: storage provider adapters (spec/openapi/provider.yaml, SPEC 4.4 and 8). No DOM.
// Every adapter offers: getKeyring, putKeyring, header, list, append, deleteWallet; HTTP providers may also offer
// notices and recovery. Only ciphertext ever leaves the wallet.

import * as C from './vledger-crypto.js';

const te = new TextEncoder();

// ---- restore codes: "<kind>:<location>#<walletId>" (SPEC 8) ----

export function restoreCode(p, walletId) {
  if (p.kind === 'github') return `github:${p.config.owner}/${p.config.repo}#${walletId}`;
  return `${p.kind}:${p.url}#${walletId}`;
}

export function parseRestoreCode(text) {
  const m = String(text || '').trim().match(/^(aevri|custom|github):(.+)#([0-9a-f-]{36})$/);
  if (!m) return null;
  if (m[1] === 'github') {
    const [owner, repo] = m[2].split('/');
    return owner && repo ? { kind: 'github', config: { owner, repo }, walletId: m[3] } : null;
  }
  return /^https?:\/\//.test(m[2]) ? { kind: m[1], url: m[2].replace(/\/$/, ''), walletId: m[3] } : null;
}

export const AEVRI_URL = 'https://aeilus.institute/api/v1/vledger';

export function makeProvider(cfg) {
  if (cfg.kind === 'github') return new GitHubProvider(cfg.config || {});
  return new HttpProvider(cfg.url || AEVRI_URL, { ageConfirmed: !!cfg.ageConfirmed });
}

// ---- HTTP provider ----

export class HttpProvider {
  constructor(url, { ageConfirmed = false } = {}) {
    this.url = url.replace(/\/$/, '');
    this.ageConfirmed = ageConfirmed;
    // The account cookie goes only to the page's own site (the institute when the app runs there).
    this.credentials = typeof location !== 'undefined' && new URL(this.url).origin === location.origin ? 'include' : 'omit';
  }

  async req(method, path, { body, session, address } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) {
      const ch = await (await fetch(this.url + '/challenge', { credentials: this.credentials })).json();
      headers['X-Vledger-Address'] = address || session.address;
      headers['X-Vledger-Challenge'] = ch.challenge;
      headers['X-Vledger-Proof'] = await C.sign(session.signer, te.encode(ch.challenge));
    }
    const r = await fetch(this.url + path, { method, headers, credentials: this.credentials, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 404) return null;
    if (!r.ok) {
      let code = r.status;
      try { code = (await r.json()).code || code; } catch { /* no body */ }
      const err = new Error(`provider ${method} ${path}: ${code}`);
      err.code = code;
      throw err;
    }
    return r.status === 204 ? true : r.json();
  }

  getKeyring(id) { return this.req('GET', `/wallets/${id}/keyring`); }
  putKeyring(doc, session) { return this.req('PUT', `/wallets/${doc.walletId}/keyring`, { body: { walletId: doc.walletId, createdAt: doc.createdAt, keyring: doc.keyring, ...(this.ageConfirmed ? { ageConfirmed: true } : {}) }, session }); }
  header(id) { return this.req('GET', `/wallets/${id}`); }

  async list(id) {
    const out = [];
    let after = 0;
    for (;;) {
      const page = await this.req('GET', `/wallets/${id}/records?after=${after}&limit=1000`);
      if (!page) return out;
      out.push(...page.items);
      if (!page.more) return out;
      after = page.cursor;
    }
  }

  async append(id, items, session) {
    let added = 0, erased = 0;
    for (let i = 0; i < items.length; i += 500) {
      const r = await this.req('POST', `/wallets/${id}/records`, { body: items.slice(i, i + 500), session });
      added += r.added; erased += r.erased;
    }
    return { added, erased };
  }

  deleteWallet(id, session) { return this.req('DELETE', `/wallets/${id}`, { session }); }
  notices(id) { return this.req('GET', `/wallets/${id}/notices`).then((x) => x || []); }
  recoveryOffer() { return this.req('GET', '/recovery'); }

  // Files a recovery request; keep the returned private key in memory until the release arrives.
  async requestRecovery(walletId, slotId, contact = '') {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']); // private key never leaves the device
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const r = await this.req('POST', '/recovery/requests', { body: { walletId, slotId, clientEpk: { kty, crv, x, y }, contact } });
    if (!r) throw new Error('this provider has no recovery slot for this wallet');
    return { ...r, privateKey: kp.privateKey };
  }

  // Returns {status} or {status: 'ready', dek} once the provider releases it.
  async pollRecovery(requestId, privateKey) {
    const r = await this.req('GET', `/recovery/requests/${requestId}`);
    if (!r || r.status !== 'ready') return r || { status: 'unknown' };
    const info = `aevri.vledger/1|recovery-release|${requestId}`;
    const epk = await crypto.subtle.importKey('jwk', r.release.epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
    const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const key = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) }, base, 256);
    const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const dek = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: C.unb64u(r.release.iv), additionalData: te.encode(info) }, aes, C.unb64u(r.release.ct)));
    return { status: 'ready', dek };
  }

  cancelRecovery(requestId, session) { return this.req('DELETE', `/recovery/requests/${requestId}`, { session }); }
}

// ---- GitHub provider: a private repository of the holder (SPEC 8 GitHub layout) ----

const b64 = (s) => btoa(String.fromCharCode(...te.encode(s)));
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export class GitHubProvider {
  constructor({ owner, repo, branch = 'main', token = '', apiBase = 'https://api.github.com' }) {
    Object.assign(this, { owner, repo, branch, token, apiBase: apiBase.replace(/\/$/, '') });
  }

  async gh(method, path, body) {
    const r = await fetch(`${this.apiBase}/repos/${this.owner}/${this.repo}/contents/${path}${method === 'GET' ? `?ref=${encodeURIComponent(this.branch)}` : ''}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status}`);
    return r.json();
  }

  async readJson(path) {
    const f = await this.gh('GET', path);
    return f && f.type === 'file' ? { sha: f.sha, data: JSON.parse(unb64(f.content)) } : null;
  }

  async writeJson(path, data, message) {
    const cur = await this.gh('GET', path);
    return this.gh('PUT', path, { message, content: b64(JSON.stringify(data)), branch: this.branch, ...(cur?.sha ? { sha: cur.sha } : {}) });
  }

  async getKeyring(id) { return (await this.readJson(`vledger/${id}/wallet.json`))?.data.keyring || null; }

  async header(id) {
    const w = await this.readJson(`vledger/${id}/wallet.json`);
    return w ? { walletId: id, createdAt: w.data.createdAt, revision: w.data.keyring.revision } : null;
  }

  async putKeyring(doc) {
    const cur = await this.getKeyring(doc.walletId);
    if (cur && cur.revision > doc.keyring.revision) throw new Error('GitHub copy has a newer keyring');
    await this.writeJson(`vledger/${doc.walletId}/wallet.json`, { walletId: doc.walletId, createdAt: doc.createdAt, keyring: doc.keyring }, 'value wallet keyring');
    return true;
  }

  async list(id) {
    const dir = await this.gh('GET', `vledger/${id}/records`);
    if (!dir) return [];
    const out = [];
    for (const f of dir.filter((x) => x.type === 'file')) {
      const j = await this.readJson(f.path);
      if (j) out.push(j.data);
    }
    return out;
  }

  async append(id, items) {
    let added = 0, erased = 0;
    for (const it of items) {
      await this.writeJson(`vledger/${id}/records/${it.id}.json`, it, it.erased ? 'value wallet erase' : 'value wallet record');
      if (it.erased) erased++; else added++;
    }
    return { added, erased };
  }

  async deleteWallet(id) {
    const walk = async (path) => {
      const dir = await this.gh('GET', path);
      if (!dir) return;
      for (const f of Array.isArray(dir) ? dir : [dir]) {
        if (f.type === 'dir') await walk(f.path);
        else await this.gh('DELETE', f.path, { message: 'value wallet removed', sha: f.sha, branch: this.branch });
      }
    };
    await walk(`vledger/${id}`);
    return true;
  }

  async notices() { return []; }
  async recoveryOffer() { return null; }
}

// ---- relay and arbiter clients (L3; spec/openapi/relay.yaml, arbiter.yaml) ----

export const AEVRI_RELAY = 'https://aeilus.institute/api/v1/vledger/relay';
export const AEVRI_ARBITER = 'https://aeilus.institute/api/v1/vledger/arbiter';

async function proofHeaders(base, session, address) {
  const ch = await (await fetch(base + '/challenge', { credentials: 'omit' })).json();
  return { 'X-Vledger-Address': address || session.address, 'X-Vledger-Challenge': ch.challenge, 'X-Vledger-Proof': await C.sign(session.signer, te.encode(ch.challenge)) };
}

async function call(url, opts = {}) {
  const r = await fetch(url, { credentials: 'omit', ...opts });
  if (r.status === 404) return null;
  if (!r.ok) {
    let code = r.status;
    try { code = (await r.json()).code || code; } catch { /* no body */ }
    const err = new Error(`${opts.method || 'GET'} ${url}: ${code}`);
    err.code = code;
    throw err;
  }
  return r.status === 204 ? true : r.json();
}

export class RelayClient {
  constructor(url = AEVRI_RELAY) { this.url = url.replace(/\/$/, ''); }
  policy() { return call(this.url + '/policy'); }
  send(msg) { return call(this.url + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }); }
  async inbox(session) { return (await call(`${this.url}/inbox/${encodeURIComponent(session.address)}`, { headers: await proofHeaders(this.url, session) })) || []; }
  getCard(address) { return call(`${this.url}/cards/${encodeURIComponent(address)}`); }
  publishCard(cardDoc) { return call(`${this.url}/cards/${encodeURIComponent(cardDoc.card.address)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cardDoc) }); }
  async withdrawCard(session) { return call(`${this.url}/cards/${encodeURIComponent(session.address)}`, { method: 'DELETE', headers: await proofHeaders(this.url, session) }); }
}

export const AEVRI_REGISTRY = 'https://aeilus.institute/api/v1/vledger/registry/aevri';

// A public registry by URL (SPEC 12). It must say it lives at that URL; the signature is checked by the caller.
export async function fetchRegistry(url) {
  const doc = await call(url, { headers: { Accept: 'application/json' } });
  if (!doc?.registry || doc.registry.type !== 'aevri.vledger.registry') throw new Error('not a registry');
  if (doc.registry.registryUrl !== url) throw new Error('the registry lives at another address: ' + doc.registry.registryUrl);
  return doc;
}

export class ArbiterClient {
  constructor(url = AEVRI_ARBITER) { this.url = url.replace(/\/$/, ''); }
  async ref() {
    const k = await call(this.url + '/key');
    return { url: this.url, key: k.key, name: k.name || this.url, rulesUrl: k.rulesUrl };
  }
  stamp(bundle, digest) {
    return call(this.url + '/stamps', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptDigest: digest, keys: bundle.receipt.parties.map((p) => p.key), signatures: bundle.signatures }) });
  }
  async lookup(digest, session) { return call(`${this.url}/stamps/${encodeURIComponent(digest)}`, { headers: await proofHeaders(this.url, session) }); }
  // A party opens a case and discloses the receipt (SPEC 10); the ruling arrives later at /cases/{caseId}.
  async openCase(c, session) {
    return call(this.url + '/cases', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await proofHeaders(this.url, session)) }, body: JSON.stringify(c) });
  }
  async getCase(caseId, session) { return call(`${this.url}/cases/${encodeURIComponent(caseId)}`, { headers: await proofHeaders(this.url, session) }); }
}
