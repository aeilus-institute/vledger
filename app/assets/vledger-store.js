// Value Wallet L1: wallet model over the aevri.vledger 1.0 reference (spec/SPEC.md) and on-device storage.
// No DOM. The wallet document is always stored encrypted; decrypted payloads live in memory only while unlocked.

import * as C from './vledger-crypto.js';
import { makeProvider } from './vledger-providers.js';

export const MIN_PASSPHRASE = 14;

export function passphraseOk(p) {
  const s = (p || '').trim();
  return s.length >= MIN_PASSPHRASE || s.split(/\s+/).filter((w) => w.length >= 2).length >= 4;
}

// ---- IndexedDB (provider "device") ----

const DB = 'aevri-vledger';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('wallets')) r.result.createObjectStore('wallets');
      if (!r.result.objectStoreNames.contains('recovery')) r.result.createObjectStore('recovery');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn, storeName = 'wallets') {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const out = fn(t.objectStore(storeName));
    t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const device = {
  async list() {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).map((d) => ({ walletId: d.walletId, createdAt: d.createdAt, label: d.extensions?.label || '', records: d.records.length }));
  },
  get: (id) => tx('readonly', (s) => s.get(id)),
  put: (doc) => tx('readwrite', (s) => s.put(doc, doc.walletId)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
};

// Pending recovery requests on this device: {requestId, walletId, cfg, privateKey (non-extractable CryptoKey)}.
export const pendingRecovery = {
  list: () => tx('readonly', (s) => s.getAll(), 'recovery').then((x) => x || []),
  put: (r) => tx('readwrite', (s) => s.put(r, r.requestId), 'recovery'),
  remove: (id) => tx('readwrite', (s) => s.delete(id), 'recovery'),
};

// ---- wallet ----

const DEFAULT_SETTINGS = {
  planCountDefault: 0, planCountBy: [], requests: { blockAll: false, blockSystems: [], blockContacts: [] },
  relays: [], arbiters: [], providers: [{ kind: 'device' }], storage: { stores: false, publishes: 'no' },
};

export class Wallet {
  constructor(doc, session, store = device) {
    this.doc = doc;
    this.session = session;
    this.store = store;
    this.items = new Map(); // record id -> { id, seq, payload | null }
  }

  static async create(passphrase, { label = '', iterations, store = device } = {}) {
    const { doc, session } = await C.createWallet(passphrase, { iterations });
    doc.extensions.label = label;
    const w = new Wallet(doc, session, store);
    await w.add('settings', { ...DEFAULT_SETTINGS });
    await w.add('contact', { type: 'self', name: label || 'Me', address: session.address });
    return w;
  }

  static async unlock(doc, passphrase, store = device) {
    const session = await C.unlockWithPassphrase(doc, passphrase);
    const w = new Wallet(doc, session, store);
    await w.decryptAll();
    return w;
  }

  get id() { return this.doc.walletId; }

  async decryptAll() {
    this.items.clear();
    for (const env of this.doc.records) {
      this.items.set(env.id, { id: env.id, seq: env.seq, payload: env.erased ? null : await C.readRecord(this.doc, this.session, env) });
    }
  }

  async save() { if (this.store) await this.store.put(this.doc); }

  lock() { this.session = null; this.items.clear(); }

  async add(kind, body, { supersedes = null, source = 'manual', createdAt } = {}) {
    const payload = { kind, createdAt: createdAt || C.nowIso(), supersedes, source, body };
    const env = await C.addRecord(this.doc, this.session, payload);
    this.items.set(env.id, { id: env.id, seq: env.seq, payload });
    await this.save();
    return env.id;
  }

  // A correction is a new record of the same kind that supersedes the current head (SPEC 6).
  async correct(id, body) {
    const head = this.head(this.rootOf(id));
    return this.add(head.payload.kind, body, { supersedes: head.id });
  }

  async withdraw(id) {
    const head = this.head(this.rootOf(id));
    return this.add(head.payload.kind, { withdrawn: true }, { supersedes: head.id });
  }

  // Erase every version of an item: content removed, tombstones keep the chain (SPEC 5.2).
  async eraseItem(id) {
    const root = this.rootOf(id);
    const ids = this.versions(root).map((v) => v.id);
    for (const rid of ids) {
      C.erase(this.doc, rid);
      this.items.set(rid, { ...this.items.get(rid), payload: null });
    }
    await this.save();
    return ids.length;
  }

  // ---- lineage: references always point to the root id of an item ----

  rootOf(id) {
    let cur = this.items.get(id);
    while (cur && cur.payload && cur.payload.supersedes && this.items.get(cur.payload.supersedes)?.payload) {
      cur = this.items.get(cur.payload.supersedes);
    }
    return cur ? cur.id : id;
  }

  versions(rootId) {
    const out = [];
    let cur = this.items.get(rootId);
    const next = new Map();
    for (const it of this.items.values()) if (it.payload?.supersedes) next.set(it.payload.supersedes, it);
    while (cur) { out.push(cur); cur = next.get(cur.id); }
    return out;
  }

  head(rootId) {
    const v = this.versions(rootId).filter((x) => x.payload);
    return v[v.length - 1] || null;
  }

  // Current items of one kind: [{ rootId, id, body, createdAt, firstAt, versions }]
  list(kind) {
    const roots = [];
    for (const it of this.items.values()) {
      if (!it.payload || it.payload.kind !== kind) continue;
      if (it.payload.supersedes && this.items.get(it.payload.supersedes)?.payload) continue; // not a root
      roots.push(it.id);
    }
    const out = [];
    for (const r of roots) {
      const vs = this.versions(r).filter((x) => x.payload);
      const h = vs[vs.length - 1];
      if (!h || h.payload.body.withdrawn) continue;
      out.push({ rootId: r, id: h.id, body: h.payload.body, createdAt: h.payload.createdAt, firstAt: vs[0].payload.createdAt, source: h.payload.source, versions: vs.length });
    }
    return out;
  }

  get(rootId) {
    const h = this.head(rootId);
    return h && !h.payload.body.withdrawn ? { rootId, id: h.id, body: h.payload.body, createdAt: h.payload.createdAt } : null;
  }

  settings() {
    const s = this.list('settings')[0];
    return { ...DEFAULT_SETTINGS, ...(s ? s.body : {}) };
  }

  async saveSettings(body) {
    const s = this.list('settings')[0];
    return s ? this.correct(s.rootId, body) : this.add('settings', body);
  }

  // ---- export, import, merge ----

  exportEncrypted() { return JSON.parse(JSON.stringify(this.doc)); }

  exportReadable() {
    return { format: 'aevri.vledger.readable', version: '1.0', walletId: this.id, exportedAt: C.nowIso(),
      warning: 'Not encrypted. Anyone with this file can read it.',
      records: [...this.items.values()].sort((a, b) => a.seq - b.seq).map((it) => ({ id: it.id, seq: it.seq, payload: it.payload })) };
  }

  // Merge another copy of the same wallet: append envelopes we do not have, apply its tombstones (SPEC 8).
  async merge(other) {
    if (other.walletId !== this.id) throw new Error('different wallet');
    const have = new Map(this.doc.records.map((r) => [r.id, r]));
    let added = 0, erased = 0;
    for (const r of other.records) {
      const mine = have.get(r.id);
      if (!mine && !r.erased) {
        const prevHash = this.doc.records.length
          ? await C.hashJson(C.linkOf(this.doc.records[this.doc.records.length - 1]))
          : await C.hashJson({ walletId: this.doc.walletId, createdAt: this.doc.createdAt });
        const env = { ...r, seq: this.doc.records.length + 1, prevHash };
        this.doc.records.push(env);
        this.items.set(env.id, { id: env.id, seq: env.seq, payload: await C.readRecord(this.doc, this.session, env) });
        added++;
      } else if (mine && r.erased && !mine.erased) {
        C.erase(this.doc, r.id, r.erased);
        this.items.set(r.id, { ...this.items.get(r.id), payload: null });
        erased++;
      }
    }
    await this.save();
    return { added, erased };
  }

  verify() { return C.verifyChain(this.doc); }

  // ---- d2: self, card, messages, suggestions (SPEC 3, 11, 13) ----

  get address() { return this.session.address; }

  selfContact() { return this.list('contact').find((c) => c.body.type === 'self'); }

  async card() {
    const s = this.settings();
    return C.makeCard(this.session, { kind: 'person', name: this.doc.extensions.label || undefined, storage: s.storage || { stores: false, publishes: 'no' } });
  }

  contactByAddress(address) { return this.list('contact').find((c) => c.body.address === address); }

  // Add or update a contact from a signed card. Returns the contact root id.
  async addCard(cardDoc) {
    if (!(await C.verifyCard(cardDoc))) throw new Error('card signature does not verify');
    const c = cardDoc.card;
    const existing = this.contactByAddress(c.address);
    const body = { type: c.kind, name: existing?.body.name || c.name || c.address.slice(0, 12), address: c.address, card: cardDoc };
    if (existing) { await this.correct(existing.rootId, { ...existing.body, ...body, name: existing.body.name }); return existing.rootId; }
    return this.add('contact', body);
  }

  // Encrypt an assessment share for a contact that has a card (SPEC 11). Returns the message to deliver.
  async prepareShare(contactRootId, body, { about, anonymous = false } = {}) {
    const c = this.get(contactRootId);
    if (!c?.body.card) throw new Error('this contact has no card yet');
    const msg = await C.sealMessage(c.body.card, body, anonymous ? null : this.session);
    await this.add('message-out', { to: c.body.address, kind: body.kind, sentAt: msg.sentAt, envelopeDigest: await C.messageDigest(msg), ...(about ? { about } : {}) });
    return msg;
  }

  // Receive one message. Blocked requests are dropped without a trace (returns {dropped: true}).
  async receive(msg) {
    const { body, from, verified } = await C.openMessage(this.session, msg);
    if (body.kind === 'request' && C.requestBlocked(this.settings(), body, from, this.list('contact'), this.list('value-system'))) {
      return { dropped: true };
    }
    const id = await this.add('message-in', { envelopeDigest: await C.messageDigest(msg), ...(from ? { from } : {}), verified, receivedAt: C.nowIso(), body, state: 'new' }, { source: 'message' });
    if (body.kind === 'suggestion') await this.addSuggestions(body, from);
    return { id, body, from, verified };
  }

  async addSuggestions(body, from) {
    const self = this.selfContact();
    let device = from ? this.contactByAddress(from) : null;
    const deviceId = device ? device.rootId : await this.add('contact', { type: 'device', name: body.source || 'Device', ...(from ? { address: from } : {}) });
    const ids = [];
    for (const e of body.events) {
      const resolve = async (name) => {
        if (!name || /^(me|я)$/i.test(name.trim())) return self.rootId;
        const found = this.list('contact').find((c) => c.body.name.toLowerCase() === name.trim().toLowerCase());
        return found ? found.rootId : this.add('contact', { type: 'unknown', name: name.trim() });
      };
      const actor = await resolve(e.actor);
      const affected = [];
      for (const a of e.affected || []) affected.push(await resolve(a));
      ids.push(await this.add('event', {
        actor, action: e.action, objects: (e.objects || []).map((label) => ({ label })), affected,
        role: actor === self.rootId ? 'actor' : (affected.includes(self.rootId) ? 'affected' : 'witness'),
        occurredAt: e.occurredAt || C.nowIso(), status: 'suggested', suggestedBy: deviceId, stamps: [], rulings: [],
      }, { source: 'device' }));
    }
    return ids;
  }

  async setMessageState(rootId, state) {
    const m = this.get(rootId);
    return this.correct(rootId, { ...m.body, state });
  }

  // ---- L2: providers, sync, recovery (SPEC 4.4, 8) ----

  providers() { return (this.settings().providers || []).filter((p) => p.kind !== 'device' && p.kind !== 'file'); }

  async saveProvider(cfg) {
    const cur = this.settings();
    const list = (cur.providers || []).filter((p) => p.id !== cfg.id);
    list.push(cfg);
    await this.saveSettings({ ...cur, providers: list });
  }

  async removeProviderConfig(id) {
    const cur = this.settings();
    await this.saveSettings({ ...cur, providers: (cur.providers || []).filter((p) => p.id !== id) });
  }

  // Two-way sync with one provider. Returns {up, down, erased, keyring, notices}.
  async syncWith(cfg, provider = makeProvider(cfg)) {
    const id = this.id;
    let keyringAction = 'same';
    const remote = await provider.getKeyring(id);
    if (!remote || remote.revision < this.doc.keyring.revision) {
      await provider.putKeyring(this.doc, this.session);
      keyringAction = 'uploaded';
    } else if (remote.revision > this.doc.keyring.revision) {
      // Newer keyring from another device (for example a new passphrase): adopt it if it holds our DEK.
      await C.open(this.session.dek, remote.identity.wrap, 'identity', id, 'identity');
      this.doc.keyring = remote;
      await this.save();
      keyringAction = 'adopted';
    }
    const items = await provider.list(id);
    const theirs = new Map(items.map((r) => [r.id, r]));
    const merged = await this.merge({ walletId: id, records: items });
    const toSend = this.doc.records.filter((r) => !theirs.has(r.id) || (r.erased && !theirs.get(r.id).erased));
    if (toSend.length) await provider.append(id, toSend.map((r) => ({ ...r })), this.session);
    const notices = provider.notices ? await provider.notices(id) : [];
    // Last sync time is device-local metadata (never uploaded: providers receive only the keyring and records).
    if (cfg.id) { this.doc.extensions.lastSync = { ...(this.doc.extensions.lastSync || {}), [cfg.id]: C.nowIso() }; await this.save(); }
    return { up: toSend.length, down: merged.added, erased: merged.erased, keyring: keyringAction, notices };
  }

  // Add a provider-recovery slot for a provider that offers recovery (TZ D-9), then sync the keyring.
  async enableRecovery(cfg, provider = makeProvider(cfg)) {
    const offer = await provider.recoveryOffer();
    if (!offer) throw new Error('this provider does not offer recovery');
    const slotId = 'r-' + C.b64u(C.rand(4)).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    await C.addProviderRecoverySlot(this.doc, this.session, { providerId: offer.providerId, keyId: offer.keyId, providerPublicJwk: offer.publicJwk, slotId });
    await this.save();
    await this.saveProvider({ ...cfg, recovery: { slotId, keyId: offer.keyId } });
    await provider.putKeyring(this.doc, this.session);
    return offer;
  }

  async disableRecovery(cfg, provider = makeProvider(cfg)) {
    const slotId = cfg.recovery?.slotId;
    this.doc.keyring.slots = this.doc.keyring.slots.filter((s) => s.id !== slotId);
    this.doc.keyring.revision += 1;
    await this.save();
    const { recovery, ...rest } = cfg;
    await this.saveProvider(rest);
    await provider.putKeyring(this.doc, this.session);
  }

  // Restore a copy on a new device: rebuild the chain in the provider's order, then open it (SPEC 8).
  static async restore(cfg, walletId, passphrase, store = device) {
    const provider = makeProvider(cfg);
    const head = await provider.header(walletId);
    const keyring = await provider.getKeyring(walletId);
    if (!head || !keyring) throw new Error('no copy of this wallet at the provider');
    const doc = await C.rebuildDoc(walletId, head.createdAt, keyring, await provider.list(walletId));
    const w = await Wallet.unlock(doc, passphrase, store);
    await w.save();
    return w;
  }

  // After a provider released the DEK (SPEC 4.4): rebuild, open with the DEK, set a new passphrase, upload the keyring.
  static async recoverWithDek(cfg, walletId, dek, newPassphrase, store = device) {
    const provider = makeProvider(cfg);
    const head = await provider.header(walletId);
    const keyring = await provider.getKeyring(walletId);
    const doc = await C.rebuildDoc(walletId, head.createdAt, keyring, await provider.list(walletId));
    const session = await C.unlockWithDek(doc, dek);
    const w = new Wallet(doc, session, store);
    await w.decryptAll();
    await w.changePassphrase(newPassphrase);
    await provider.putKeyring(w.doc, w.session);
    return w;
  }

  // Re-wrap the DEK under a new passphrase; records are not re-encrypted (TZ CR-4).
  async changePassphrase(passphrase) {
    const slot = this.doc.keyring.slots.find((s) => s.kind === 'passphrase');
    const kdf = C.newKdf();
    const kek = await C.deriveKek(passphrase, kdf);
    slot.kdf = kdf;
    slot.wrap = await C.seal(kek, this.session.dek, 'slot', this.doc.walletId, slot.id);
    this.doc.keyring.revision += 1;
    await this.save();
  }
}

// Basic structural check of an imported document before asking for its passphrase.
export async function inspectImport(doc) {
  const problems = [];
  if (!doc || doc.format !== C.FORMAT) problems.push('format');
  else if (!/^1\./.test(doc.version || '')) problems.push('version');
  else if (!doc.keyring?.slots?.some((s) => s.kind === 'passphrase')) problems.push('keyring');
  const chain = problems.length ? [] : await C.verifyChain(doc);
  return { ok: problems.length === 0, problems, chain };
}
