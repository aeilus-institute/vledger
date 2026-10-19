// Value Wallet L1: wallet model over the aevri.vledger 1.0 reference (spec/SPEC.md) and on-device storage.
// No DOM. The wallet document is always stored encrypted; decrypted payloads live in memory only while unlocked.

import * as C from './vledger-crypto.js';

// One-click reactions, the scale readers use on the institute site (SPEC 17)
export const REACTIONS = [-100, -20, 0, 20, 100, 500];
import { makeProvider, RelayClient, ArbiterClient } from './vledger-providers.js';
import { applyReceipt } from './vledger-streams.js';

export const MIN_PASSPHRASE = 14;

export function passphraseOk(p) {
  const s = (p || '').trim();
  return s.length >= MIN_PASSPHRASE || s.split(/\s+/).filter((w) => w.length >= 2).length >= 4;
}

// ---- IndexedDB (provider "device") ----

const DB = 'aevri-vledger';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 4);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('wallets')) r.result.createObjectStore('wallets');
      if (!r.result.objectStoreNames.contains('recovery')) r.result.createObjectStore('recovery');
      if (!r.result.objectStoreNames.contains('biometric')) r.result.createObjectStore('biometric');
      if (!r.result.objectStoreNames.contains('streamkeys')) r.result.createObjectStore('streamkeys');
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

// Unlock by this device's biometrics (SPEC 18): {walletId, credentialId, salt, rpId, wrap}, kept on this device only.
export const biometricKeys = {
  get: (walletId) => tx('readonly', (s) => s.get(walletId), 'biometric'),
  put: (rec) => tx('readwrite', (s) => s.put(rec, rec.walletId), 'biometric'),
  remove: (walletId) => tx('readwrite', (s) => s.delete(walletId), 'biometric'),
};

// Subscription keys of event streams (SPEC 20.4): {key: walletId|address, address, encKey, wrap}, sealed with the data
// key, kept on this device only and never in the wallet document.
export const streamKeys = {
  get: (key) => tx('readonly', (s) => s.get(key), 'streamkeys'),
  put: (rec) => tx('readwrite', (s) => s.put(rec, rec.key), 'streamkeys'),
  remove: (key) => tx('readwrite', (s) => s.delete(key), 'streamkeys'),
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

  // Opens with the data key itself (device biometrics, SPEC 18)
  static async openWithDek(doc, dek, store = device) {
    const session = await C.unlockWithDek(doc, dek);
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

  // Puts every item of a verified registry on the timeline once and, for items the holder evaluated on the
  // publisher's site, adds a realized assessment with that reaction as own score (owner, 2026-10-17). Evaluated items
  // become "I read it" events on the date of the reaction; the others "the publisher published it" on the publication
  // date. Running it again adds only what is new. Returns {events, assessments, updated}.
  // The wallet's value system for one system of a registry (SPEC 17): one per registry system, made on first use.
  // A system made by an earlier version for the whole registry is kept and becomes the one of its first system.
  async registrySystem(reg, systemId) {
    const all = this.list('value-system').filter((s) => s.body.registryUrl === reg.registryUrl);
    const hit = all.find((s) => s.body.registrySystemId === systemId);
    if (hit) return hit.rootId;
    const rs = (reg.systems || []).find((s) => s.systemId === systemId);
    const legacy = all.find((s) => !s.body.registrySystemId && s.body.title === (rs?.title || ''));
    if (legacy) { await this.correct(legacy.rootId, { ...legacy.body, registrySystemId: systemId }); return legacy.rootId; }
    return this.add('value-system', { title: rs?.title || systemId || reg.owner.card.name || 'Registry', W: 1, status: 'active', registryUrl: reg.registryUrl, registrySystemId: systemId }, { source: 'registry' });
  }

  // One-click reaction (SPEC 17): sets the reaction of the realized assessment of an event, creating it if needed.
  async react(eventRootId, value) {
    if (!REACTIONS.includes(value)) throw new Error('unknown reaction');
    const cur = this.list('assessment').filter((a) => a.body.eventId === eventRootId && a.body.phase === 'realized').pop();
    if (cur) return this.correct(cur.rootId, { ...cur.body, reaction: value });
    return this.add('assessment', { eventId: eventRootId, phase: 'realized', confidence: 'medium', reference: false, contributions: [], spent: [], reaction: value });
  }

  // Adds to the realized assessment of an event (comparison, goal contributions), creating it if needed (SPEC 17)
  async refine(eventRootId, fields) {
    const cur = this.list('assessment').filter((a) => a.body.eventId === eventRootId && a.body.phase === 'realized').pop();
    if (cur) return this.correct(cur.rootId, { ...cur.body, ...fields });
    return this.add('assessment', { eventId: eventRootId, phase: 'realized', confidence: 'medium', reference: false, contributions: [], spent: [], ...fields });
  }

  // Links a VSS schema to a sphere and keeps a copy of the schema document (SPEC 19)
  async linkSchema(sphereId, { schemaId, title, doc, holderNodeId, nodeContacts = {}, source = 'link' }) {
    const sys = this.get(sphereId);
    if (!sys) throw new Error('no sphere');
    if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.flows)) throw new Error('not a VSS schema');
    if (!doc.nodes.some((n) => n.id === holderNodeId)) throw new Error('the holder node is not in the schema');
    const originId = 'vss:' + schemaId;
    const payloadHash = await C.hashJson(doc);
    const imp = this.list('import').find((i) => i.body.originId === originId);
    if (!imp) await this.add('import', { origin: source === 'file' ? 'file' : 'url', originId, payload: doc, payloadHash }, { source: 'vss' });
    else if (imp.body.payloadHash !== payloadHash) await this.correct(imp.rootId, { ...imp.body, payload: doc, payloadHash });
    const list = (sys.body.vss || []).filter((x) => x.schemaId !== schemaId);
    list.push({ schemaId, title: String(title || doc.schema?.name || schemaId).slice(0, 300), holderNodeId, nodeContacts, source });
    return this.correct(sphereId, { ...sys.body, vss: list });
  }

  schemaDoc(schemaId) { return this.list('import').find((i) => i.body.originId === 'vss:' + schemaId)?.body.payload || null; }

  async unlinkSchema(sphereId, schemaId) {
    const sys = this.get(sphereId);
    return this.correct(sphereId, { ...sys.body, vss: (sys.body.vss || []).filter((x) => x.schemaId !== schemaId) });
  }

  async importRegistryItems(doc, evaluations = [], { unit = 'ÆVRI reaction', today } = {}) {
    const reg = doc.registry;
    const day = today || C.nowIso().slice(0, 10);
    const ownerId = await this.addCard(reg.owner);
    const imp = this.list('import').find((i) => i.body.originId === reg.registryUrl);
    const payloadHash = await C.hashJson(doc);
    if (!imp) await this.add('import', { origin: 'url', originId: reg.registryUrl, payload: doc, payloadHash }, { source: 'registry' });
    else if (imp.body.payloadHash !== payloadHash) await this.correct(imp.rootId, { ...imp.body, payload: doc, payloadHash });
    const me = this.selfContact().rootId;
    const evals = new Map(evaluations.filter((e) => e && typeof e.itemId === 'string').map((e) => [e.itemId, e]));
    const have = new Map(this.list('event').filter((e) => e.body.registryRef?.registryUrl === reg.registryUrl).map((e) => [e.body.registryRef.itemId, e]));
    const assessed = new Set(this.list('assessment').filter((a) => this.head(a.rootId)?.payload.source === 'aevri.site').map((a) => a.body.eventId));
    const out = { events: 0, assessments: 0, updated: 0 };
    for (const it of reg.items) {
      const ev = evals.get(it.itemId);
      const rated = ev && typeof ev.value === 'number';
      const ref = { registryUrl: reg.registryUrl, itemId: it.itemId, owner: reg.owner.card.address };
      const sysId = await this.registrySystem(reg, it.system);
      const read = { role: 'user', actor: me, action: (it.actions || [])[0] || 'read', occurredAt: (ev?.at || '').slice(0, 10) || day };
      let cur = have.get(it.itemId);
      if (!cur) {
        const base = { objects: [{ label: it.title }], affected: [], systemId: sysId, registryRef: ref, status: 'confirmed', stamps: [], rulings: [] };
        const body = rated ? { ...base, ...read } : { ...base, role: 'witness', actor: ownerId, action: 'published', occurredAt: String(it.occurredAt || day).slice(0, 10) };
        const id = await this.add('event', body, { source: rated ? 'aevri.site' : 'registry' });
        cur = this.get(this.rootOf(id));
        out.events++;
      } else {
        const fix = {};
        if (rated && cur.body.role === 'witness' && cur.body.action === 'published') Object.assign(fix, read);
        if (cur.body.systemId !== sysId) fix.systemId = sysId; // earlier imports put every item into one system
        if (Object.keys(fix).length) { await this.correct(cur.rootId, { ...cur.body, ...fix }); out.updated++; }
      }
      if (rated && !assessed.has(cur.rootId)) {
        const body = { eventId: cur.rootId, phase: 'realized', confidence: 'medium', reference: false, contributions: [], spent: [] };
        if (REACTIONS.includes(ev.value)) body.reaction = ev.value; else body.ownScore = { value: ev.value, unit };
        if (ev.comment) body.reasons = String(ev.comment).slice(0, 2000);
        await this.add('assessment', body, { source: 'aevri.site' });
        out.assessments++;
      }
    }
    // a system an earlier version made for the whole registry is withdrawn once nothing refers to it
    for (const sys of this.list('value-system').filter((x) => x.body.registryUrl === reg.registryUrl && !x.body.registrySystemId)) {
      const used = this.list('event').some((e) => e.body.systemId === sys.rootId) || this.list('goal').some((g) => g.body.systemId === sys.rootId);
      if (!used) { await this.withdraw(sys.rootId); out.updated++; }
    }
    return out;
  }

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
    // a receipt for feedback sent to a stream under the holder's name (SPEC 20.11) updates that item
    if (body.kind === 'feedback-receipt') return { receipt: await applyReceipt(this, body, body.providerAddress) };
    if (body.kind === 'request' && C.requestBlocked(this.settings(), body, from, this.list('contact'), this.list('value-system'))) {
      return { dropped: true };
    }
    const id = await this.add('message-in', { envelopeDigest: await C.messageDigest(msg), ...(from ? { from } : {}), verified, receivedAt: C.nowIso(), body, state: 'new' }, { source: 'message' });
    if (body.kind === 'suggestion') await this.addSuggestions(body, from);
    let matched = false;
    if (body.kind === 'event-offer' && !body.opening && verified) {
      matched = await this.applyOfferReply(body.receipt);
      if (matched) await this.setMessageState(id, 'accepted');
    }
    return { id, body, from, verified, matched };
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

  // ---- L3: relay, card directory, receipts, arbiter ----

  relayUrl() { return (this.settings().relays || [])[0] || null; }

  // Send a message through the relay when one is set; returns true if sent, false if the caller should hand it over.
  async deliver(msg) {
    const url = this.relayUrl();
    if (!url) return false;
    await new RelayClient(url).send(msg);
    return true;
  }

  // Fetch and receive everything waiting at the relay. Returns {received, dropped, matched}.
  async checkInbox() {
    const url = this.relayUrl();
    if (!url) return { received: 0, dropped: 0, matched: 0 };
    const msgs = await new RelayClient(url).inbox(this.session);
    let received = 0, dropped = 0, matched = 0;
    for (const m of msgs) {
      try {
        const r = await this.receive(m);
        if (r.dropped) dropped++; else if (!('receipt' in r)) received++;
        if (r.matched) matched++;
      } catch { /* not for this wallet or damaged: skip */ }
    }
    return { received, dropped, matched };
  }

  async lookupCard(address) {
    const url = this.relayUrl();
    if (!url) return null;
    const doc = await new RelayClient(url).getCard(address);
    if (!doc || doc.card?.address !== address || !(await C.verifyCard(doc))) return null;
    return doc;
  }

  async publishCard() { const url = this.relayUrl(); if (!url) throw new Error('no relay'); return new RelayClient(url).publishCard(await this.card()); }
  async withdrawCard() { const url = this.relayUrl(); if (!url) throw new Error('no relay'); return new RelayClient(url).withdrawCard(this.session); }

  // Offer an event for joint confirmation (SPEC 9, 11). Returns the message to deliver to the other party.
  async offerEvent(eventRootId, otherRootId, { mode = 'attest', arbiter = null } = {}) {
    const ev = this.get(eventRootId);
    const other = this.get(otherRootId);
    if (!other?.body.card) throw new Error('the other party has no card yet');
    const me = this.selfContact().rootId;
    const b = ev.body;
    const occurredAt = String(b.occurredAt).length === 10 ? b.occurredAt + 'T00:00:00Z' : b.occurredAt;
    const action = { salt: C.b64u(C.rand(16)), text: b.action };
    const objects = (b.objects || []).map((o) => ({ salt: C.b64u(C.rand(16)), label: o.label, quantity: o.quantity ?? null, unit: o.unit ?? null, note: o.note ?? null }));
    const iAmActor = b.actor === me;
    const myRole = iAmActor ? 'actor' : (b.role === 'affected' ? 'affected' : b.role);
    const otherRole = b.actor === otherRootId ? 'actor' : (iAmActor && (b.affected || []).includes(otherRootId) ? 'affected' : 'party');
    const parties = [{ role: myRole, key: this.session.publicKey }, { role: otherRole, key: C.keyOfAddress(other.body.address) }];
    const receipt = { type: 'aevri.vledger.receipt', version: 2, receiptId: C.uuid7(), occurredAt, parties,
      action: { digest: await C.actionDigest(action), ...(b.actionType ? { type: b.actionType } : {}) },
      objects: await Promise.all(objects.map(async (o) => ({ digest: await C.objectDigest(o) }))),
      mandate: { mode, ...(arbiter && mode !== 'attest' ? { arbiter } : {}) } };
    if (arbiter) receipt.arbiters = [{ party: 0, ...arbiter }];
    const bundle = await C.signReceipt({ receipt, signatures: [] }, 0, this.session);
    const opening = { action, objects, roles: [myRole, otherRole], occurredAt };
    await this.correct(eventRootId, { ...b, receipt: bundle, receiptState: 'offered', receiptOpening: opening });
    return C.sealMessage(other.body.card, { kind: 'event-offer', receipt: bundle, opening }, this.session);
  }

  // The other party accepts an offer: records the event on its own timeline, signs, and returns the reply message.
  async acceptOffer(messageRootId) {
    const m = this.get(messageRootId);
    const { receipt: bundle, opening } = m.body.body;
    const me = this.selfContact().rootId;
    const meIdx = bundle.receipt.parties.findIndex((p) => p.key.x === this.session.publicKey.x);
    if (meIdx < 0) throw new Error('this offer is not addressed to this wallet');
    const otherIdx = meIdx === 0 ? 1 : 0;
    if (await C.actionDigest(opening.action) !== bundle.receipt.action.digest) throw new Error('the opening does not match the receipt');
    for (let i = 0; i < opening.objects.length; i++) if (await C.objectDigest(opening.objects[i]) !== bundle.receipt.objects[i]?.digest) throw new Error('the opening does not match the receipt');
    const otherAddress = C.addressOf(bundle.receipt.parties[otherIdx].key);
    let sender = this.contactByAddress(otherAddress);
    let senderId = sender?.rootId;
    if (!sender) {
      const found = await this.lookupCard(otherAddress).catch(() => null); // the published card gives a name and the reply key
      senderId = found ? await this.addCard(found) : await this.add('contact', { type: 'person', name: otherAddress.slice(0, 12), address: otherAddress });
      sender = this.get(senderId);
    }
    const roles = opening.roles;
    const otherIsActor = roles[otherIdx] === 'actor';
    const myRole = roles[meIdx] === 'party' ? (otherIsActor ? 'affected' : 'witness') : roles[meIdx];
    const signed = await C.signReceipt(JSON.parse(JSON.stringify(bundle)), meIdx, this.session);
    const status = await C.receiptStatus(signed);
    const evId = await this.add('event', {
      actor: otherIsActor ? senderId : me, action: opening.action.text,
      objects: opening.objects.map((o) => ({ label: o.label, ...(o.quantity != null ? { quantity: o.quantity } : {}), ...(o.unit ? { unit: o.unit } : {}) })),
      affected: otherIsActor ? [me] : [senderId], role: myRole, occurredAt: opening.occurredAt, status: 'confirmed',
      receipt: signed, receiptState: status.matched ? 'matched' : 'offered', receiptOpening: opening, stamps: [], rulings: [],
    }, { source: 'contact' });
    await this.setMessageState(messageRootId, 'accepted');
    const card = sender?.body.card || (await this.lookupCard(otherAddress));
    const reply = card ? await C.sealMessage(card, { kind: 'event-offer', receipt: signed }, this.session) : null;
    return { eventId: evId, reply, matched: status.matched };
  }

  // A signed reply to our own offer: store the matched receipt on our event.
  async applyOfferReply(bundle) {
    const ev = this.list('event').find((e) => e.body.receipt?.receipt?.receiptId === bundle.receipt.receiptId);
    if (!ev) return false;
    if (C.canon(ev.body.receipt.receipt) !== C.canon(bundle.receipt)) {
      await this.correct(ev.rootId, { ...ev.body, receiptState: 'disputed' });
      return false;
    }
    const st = await C.receiptStatus(bundle);
    if (!st.matched) return false;
    await this.correct(ev.rootId, { ...ev.body, receipt: bundle, receiptState: 'matched' });
    return true;
  }

  async stampAt(eventRootId, arbiterUrl) {
    const ev = this.get(eventRootId);
    const digest = await C.receiptDigest(ev.body.receipt.receipt);
    const stamp = await new ArbiterClient(arbiterUrl).stamp(ev.body.receipt, digest);
    if (!(await C.verifySigned(stamp, stamp.arbiter.key)) || stamp.receiptDigest !== digest) throw new Error('the stamp does not verify');
    await this.correct(eventRootId, { ...ev.body, stamps: [...(ev.body.stamps || []), stamp] });
    return stamp;
  }

  // Ask the arbiter (SPEC 10). request: attest | opinion | decision; a decision needs a binding mandate naming it.
  async openCase(eventRootId, { statement = '', request = 'attest', arbiterUrl } = {}) {
    const ev = this.get(eventRootId);
    const bundle = ev.body.receipt;
    if (!bundle) throw new Error('the event has no receipt');
    const claimant = bundle.receipt.parties.findIndex((p) => p.key.x === this.session.publicKey.x);
    if (claimant < 0) throw new Error('this wallet is not a party to the receipt');
    const url = (arbiterUrl || bundle.receipt.mandate?.arbiter?.url || '').replace(/\/$/, '');
    if (!url) throw new Error('no arbiter');
    const caseId = C.uuid7();
    const res = await new ArbiterClient(url).openCase({ caseId, receipt: bundle.receipt, signatures: bundle.signatures, claimant, statement, request }, this.session);
    const entry = { caseId, arbiterUrl: url, request, openedAt: C.nowIso(), status: res?.status || 'open' };
    await this.correct(eventRootId, { ...ev.body, cases: [...(ev.body.cases || []), entry] });
    return entry;
  }

  // Checks a ruling before it is kept: signed by the arbiter, about this receipt; binding only within the mandate.
  async checkRuling(ruling, bundle, arbiterKey) {
    if (!ruling || ruling.type !== 'aevri.vledger.ruling') return 'not a ruling';
    if (arbiterKey && ruling.arbiter.key.x !== arbiterKey.x) return 'signed by another key';
    if (!(await C.verifySigned(ruling, ruling.arbiter.key))) return 'signature';
    if (ruling.receiptDigest !== (await C.receiptDigest(bundle.receipt))) return 'another receipt';
    if (ruling.binding) {
      const st = await C.receiptStatus(bundle);
      const m = bundle.receipt.mandate || {};
      if (!st.binding || m.arbiter?.key?.x !== ruling.arbiter.key.x) return 'no binding mandate for this arbiter';
    }
    return null;
  }

  // Fetches the rulings of open cases of an event and keeps those that check out.
  async refreshCases(eventRootId) {
    const ev = this.get(eventRootId);
    const cases = ev.body.cases || [];
    let rulings = ev.body.rulings || [];
    let changed = false;
    const out = [];
    for (const c of cases) {
      if (c.status !== 'open') { out.push(c); continue; }
      const cli = new ArbiterClient(c.arbiterUrl);
      const r = await cli.getCase(c.caseId, this.session);
      if (!r || r.status === 'open') { out.push(c); continue; }
      const key = (await cli.ref()).key;
      const problem = r.ruling ? await this.checkRuling(r.ruling, ev.body.receipt, key) : null;
      out.push({ ...c, status: r.status, ...(problem ? { problem } : {}), ...(r.reason ? { reason: String(r.reason).slice(0, 2000) } : {}) });
      if (r.ruling && !problem && !rulings.some((x) => x.sig === r.ruling.sig)) rulings = [...rulings, r.ruling];
      changed = true;
    }
    if (!changed) return [];
    await this.correct(eventRootId, { ...ev.body, cases: out, rulings });
    return out.filter((c) => c.status !== 'open');
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
