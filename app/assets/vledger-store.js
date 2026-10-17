// Value Wallet L1: wallet model over the aevri.vledger 1.0 reference (spec/SPEC.md) and on-device storage.
// No DOM. The wallet document is always stored encrypted; decrypted payloads live in memory only while unlocked.

import * as C from './vledger-crypto.js';

export const MIN_PASSPHRASE = 14;

export function passphraseOk(p) {
  const s = (p || '').trim();
  return s.length >= MIN_PASSPHRASE || s.split(/\s+/).filter((w) => w.length >= 2).length >= 4;
}

// ---- IndexedDB (provider "device") ----

const DB = 'aevri-vledger';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('wallets');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('wallets', mode);
    const out = fn(t.objectStore('wallets'));
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

// ---- wallet ----

const DEFAULT_SETTINGS = { planCountDefault: 0, planCountBy: [], arbiters: [], providers: [{ kind: 'device' }] };

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
    await w.add('counterparty', { type: 'self', name: label || 'Me' });
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
