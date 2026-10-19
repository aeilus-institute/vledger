# Value Wallet format and protocols - `aevri.vledger` 1.0

Status: **draft 1.0-d10** (2026-10-19). Editor: Aeilus Value Research Institute (ÆVRI).
Licence: CC BY 4.0 (this text), MIT (reference code and schemas). Requirements (Russian): TZ v0.2 and v0.3.
Fixtures in `fixtures/` are produced by `reference/` (Web Crypto) and pass the independent `tools/verify_fixtures.py`.
Changes from d9: closed streams and verified people: attestations, `access: "attested"`, `requires` (20.13).
Changes from d8: event streams (section 20): providers suggest events to the people who took part,
connected by a QR code or a link; feedback to a stream and personal streams (20.11, 20.12); `stream` records, `streamRef`, `schema/stream.schema.json`.
Changes from d7: spheres link VSS schemas and show them as a map (section 19).
Changes from d6: unlock with device biometrics (section 18), kept on the device, outside the wallet document.
Changes from d6: one-click `reaction` in assessments (section 17); `registrySystemId` in value systems.
Changes from d4 (stage L4): bridges to VET and VSS (section 16, `schema/bridge.schema.json`); `event.vssRef`;
the `vet` result in assessments; `settings.bridges`.
Changes from d3 (stage L3): `opening` in event offers; the optional card directory of relays; the institute relay
and arbiter addresses (`openapi/relay.yaml`, `openapi/arbiter.yaml`).
Changes from d2 (stage L2): storage providers keep envelopes as a set and each device rebuilds its chain; restore
codes; the GitHub layout; wallet-proof authentication; the recovery request, notice, cancel and release protocol;
`settings.providers[].config`. Records are unchanged, so d2 fixtures stay valid.
Changes from d1: the exchange became an **event on a timeline** (actor, action, objects, affected contacts);
counterparties became **contacts with wallet addresses**; **value systems** group goals; assessments gained **spent
value**, **efficiency** and **reference** marks, and phases are `realized` and `retro` (expectations are plans);
**messages** (share, request, event offer, card, suggestion) replace feedback; a signed **registry** of objects and
events replaces the organisation profile; assessment **request blocking**; **suggested** events from devices and agents.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. What this is

A **value wallet** is a person's (or an organisation's, or a state body's) own encrypted timeline of events in the form
"someone did something with something or someone", with the value those events planned, realized and, looking back,
turned out to have for the holder's goals in each of the holder's value systems.

Design commitments:

1. **The holder owns it.** It lives on the holder's device by default. Storage providers, relays and arbiters are
   chosen by the holder and are replaceable.
2. **Always encrypted.** Nothing is stored or sent in plain text, unless the holder explicitly asks for a readable
   export.
3. **No common register.** Peers agree by signing the same receipt. Relays pass messages without keeping them; anyone
   who keeps received assessments says so in its signed card.
4. **No scores of people.** Value is not transferable and is never summed into a score of a person.
5. **The holder's own scale.** Comparability comes from the weight of a value system, the weight of a goal in it and
   the contribution of an event to the goal (section 7).

A system where arbiters and relays are fixed for everyone is a register, not a wallet. This specification describes a
wallet; a register MAY reuse the formats.

## 2. Building blocks

| Item | Choice |
| --- | --- |
| Identifiers | UUID version 7, lower case |
| Time | RFC 3339 in UTC with `Z`; dates `YYYY-MM-DD` |
| Binary in JSON | base64url without padding |
| Canonical JSON | JCS, RFC 8785 |
| Hash | SHA-256, written `sha256:<64 hex>` |
| Symmetric encryption | AES-256-GCM, 12-byte random IV |
| Passphrase KDF | PBKDF2-HMAC-SHA-256, at least 600 000 iterations, 16-byte salt; `argon2id` allowed |
| Signatures | Ed25519; `ES256` allowed as a fallback |
| Public-key encryption | ECDH P-256 ephemeral-static, HKDF-SHA-256, AES-256-GCM (provider recovery, messages) |

## 3. Wallet address and card

- **Address**: `vw1:` followed by the base64url of the 32-byte Ed25519 public identity key.
- **Link and QR form**: `https://aeilus.institute/w/#<address>?n=<name>&k=<kind>` (values percent-encoded, `n` and
  `k` optional). A wallet reading a QR or pasted text MUST accept both the bare address and the link form. The
  fragment never reaches a server.
- **Card** (`schema/card.schema.json`): `{card, sig}` where `card` = `{type: "aevri.vledger.card", version: 1,
  address, kind, name?, encKey (ECDH P-256 public JWK), inbox?, registryUrl?, storage, updatedAt}` and `sig` is the
  identity key's signature over the JCS form of `card`. `storage` is the **storage policy** of the card's owner for
  assessments others send to it: `{stores, purpose?, retentionDays?, publishes: "no" | "anonymous" | "named" |
  "sender-choice"}`. A wallet MUST show it before sending an assessment; no card means "unknown".
- Encrypted messages need the recipient's card (for `encKey`); a bare address is enough to name a contact as an actor.

## 4. Keys and encryption

### 4.1. Key hierarchy

- **DEK**: 32 random bytes, never stored unwrapped; wrapped in every slot of `keyring.slots[]`.
- **Record key**: 32 random bytes per record, wrapped by the DEK.
- **Identity key**: Ed25519; public part in `keyring.identity.publicKey`; private part (PKCS#8) wrapped by the DEK.
- **Exchange key**: ECDH P-256 for messages addressed to this wallet; public JWK in `keyring.exchange.publicJwk`;
  private JWK (UTF-8 JSON) wrapped by the DEK in `keyring.exchange.wrap`.

### 4.2. Wrapping

AES-256-GCM with AAD = UTF-8 of `aevri.vledger/1|<purpose>|<walletId>|<id>`, purpose one of `slot`, `identity`,
`exchange`, `record`, `payload`. Wrapped values are `{iv, ct}`.

### 4.3. Slots

| `kind` | Opens with |
| --- | --- |
| `passphrase` | PBKDF2 of the passphrase. Mandatory |
| `device` | A non-extractable platform key (optional) |
| `provider-recovery` | The provider's recovery private key after the provider's procedure (4.4); the wallet MUST say that the provider can then technically read the wallet |
| `recovery-code` | PBKDF2 of a recovery code (for 2-of-2 offers) |

### 4.4. Provider recovery slot

Ephemeral P-256 key pair; ECDH with the provider's public key; HKDF-SHA-256 with 32 zero bytes of salt and info
`aevri.vledger/1|recovery|<walletId>|<keyId>`; AES-GCM wrap of the DEK (purpose `slot`). Stored as
`{id, kind: "provider-recovery", providerId, keyId, epk, wrap}`.

**Recovery protocol** (`openapi/provider.yaml`): a device that lost the passphrase creates a fresh ephemeral P-256 key
and files a recovery request with the wallet id, the slot id and that public key. The provider shows the request as a
**notice** to every device that syncs the wallet; any of them can **cancel** it with a wallet proof. After the
provider's procedure (identity check, delay, notifications) it opens the slot with its private key and **releases**
the DEK wrapped to the request's key (ECDH with a provider ephemeral key, HKDF-SHA-256 with info
`aevri.vledger/1|recovery-release|<requestId>`, AES-256-GCM with the same string as AAD), once. The device then
replaces the passphrase slot with one for a new passphrase and uploads the keyring.

## 5. Records

### 5.1. Envelope, chain, tombstone

Envelope `{id, seq, prevHash, rk, iv, ct, ctHash}`; `prevHash` = SHA-256 of JCS `{id, seq, prevHash, ctHash}` of the
previous envelope (for `seq` 1, of `{walletId, createdAt}`); a tombstone keeps `{id, seq, prevHash, ctHash, erased}`.
The chain is for the holder's own integrity, not a proof to others.

### 5.2. Payload

`{kind, createdAt, supersedes, source, body, retainUntil?}`. `source` is one of `manual`, `import-file`, `contact`,
`registry`, `message`, `device`, `agent`, `vet`, `vss`, `aevri.site`, `aevri.vvp`, `stream`.

### 5.3. Kinds

| Kind | Body (main members) |
| --- | --- |
| `contact` | `type` (`self`, `person`, `organization`, `state`, `group`, `device`, `unknown`), `name`, `address?`, `card?` (signed card as received), `note?`, `members?` |
| `value-system` | `title`, `W` (weight on the holder's scale, > 0), `status` (`active`, `dropped`), `registryUrl?`, `note?` |
| `goal` | `title`, `systemId?`, `S`, `N?`, `unit?`, `status`, `why?`, `signs?`, `horizon?`, `factIds[]` |
| `event` | `actor` (contact id), `action` (words), `actionType?`, `objects[]` (`{label, typeId?, quantity?, unit?, note?}`), `affected[]` (contact ids), `role` (`actor`, `affected`, `user`, `witness`), `occurredAt`, `approx?`, `systemId?`, `registryRef?` (`{registryUrl, itemId, owner}`), `status` (`confirmed`, `suggested`, `rejected`), `suggestedBy?`, `receipt?`, `stamps[]`, `rulings[]`, `cases[]` (`{caseId, arbiterUrl, request, openedAt, status}`) |
| `element-type` | `name`, `category` (`thing`, `service`, `information`, `time`, `money`, `right`, `decision`, `relation`, `action`, `other`) |
| `plan` | `eventId`, `objectIndex?`, `author` (contact id; self for one's own expectation), `promise`, `plannedV?`, `plannedSpentV?`, `registryRef?` |
| `assessment` | `eventId`, `objectIndex?`, `phase` (`realized`, `retro`), `gained[]`, `lost[]`, `ownScore?`, `contributions[]` (`{goalId, c?, k?}`), `spent[]` (same shape: what it cost in terms of goals), `v?`, `spentV?`, `planCount?`, `reference` (bool), `confidence`, `reasons?`, `checkAfter?`, `vet?` |
| `fact` | `topic?`, `text`, `certainty`, `exploring`, `goalIds[]` |
| `settings` | `planCountDefault` (0..1, default 0), `planCountBy[]`, `requests` (`{blockAll, blockSystems[], blockContacts[]}`), `relays[]`, `arbiters[]`, `providers[]`, `storage` (this wallet's own storage policy for its card) |
| `message-in` | A received message after decryption: `{envelopeDigest, from?, verified, receivedAt, body, state}` with `state` `new`, `accepted`, `ignored` |
| `message-out` | A message the holder sent: `{to, kind, sentAt, envelopeDigest, about?}` |
| `grant`, `revocation`, `disclosure`, `import`, `note` | As in d1 |

Rules:

- A `retro` assessment MUST NOT be created for an `(eventId, objectIndex)` without an earlier `realized` one.
- An event with `status` other than `confirmed` MUST NOT appear on the timeline or in analytics.
- An event may have no plan and no assessment.

## 6. Corrections, withdrawal, erasure

A correction supersedes; a withdrawal is `{withdrawn: true}`; erasure turns envelopes into tombstones.

## 7. Value model

The holder uses any scale. Derived numbers:

- System weight `ω = W / sum(W of active systems)`. Goals without a system (or of an unknown one, or when there are no
  systems) belong to an implicit system "Other" whose `W` is the mean `W` of the active systems (1 when there are
  none). Goals of a dropped system weigh 0.
- Goal weight inside its system `σ = S / sum(S of active goals in that system)`.
- Global goal weight `w = ω * σ`.
- Progress share `k = c / N` (or `k` typed directly); `N` defaults to `S`.
- **Value** `v = sum over contributions (w * k)`; **spent** `spentV = sum over spent (w * k)`.
- **Efficiency** `e = v / spentV` when `spentV > 0`; **net value** `v - spentV`.
- **Planned value** counts in the holder's own figures only through `planCount` (0..1), default 0.

**Orientation while assessing.** A wallet SHOULD show, for the event's system: references (the holder's own
`reference: true` assessments in that system, and public references from the system's registry) with their `v`;
and the system's goals with `w` and progress so far.

**Feeling check plus reference.** After entry, say the result in words and, if a reference exists, the ratio to the
reference nearest in `v`. Flags as in d1 (overfilled goal, own scores disagree with `v` ranks, untouched top goal).
Never reminders.

## 8. Storage providers

`openapi/provider.yaml`. A provider keeps the keyring and the envelopes and tombstones **as a set**, in its own
order; it never needs plain text. Each device keeps its own chain (5.1): when it takes in envelopes from a provider it
appends them after its own records and recomputes `seq` and `prevHash` for them (ciphertexts and ids do not change).
A device restoring a wallet from a provider rebuilds the whole chain in the provider's order.

- **Sync** with a provider: upload the keyring if the provider has none or an older revision, adopt the provider's
  keyring if it has a newer revision (passphrase changed on another device; the DEK is the same), upload envelopes and
  tombstones the provider lacks, take in those the device lacks, and apply tombstones both ways.
- **Several providers** MAY be used at once; each sync is independent.
- **Migration**: sync the new provider, verify that it lists every id, then (only after the holder confirms) delete
  the wallet at the old one.
- **Restore code**: what a new device needs to find a copy, `<provider kind>:<location>#<walletId>`, for example
  `aevri:https://aeilus.institute/api/v1/vledger#<walletId>` or `github:<owner>/<repo>#<walletId>`. The wallet id is a
  random capability for reading ciphertext; it is not a secret that opens anything.
- **Wallet proof** for writes: the provider binds the wallet id to the address of the first uploaded keyring; later
  writes sign a fresh challenge with the identity key.
- **GitHub layout** (a private repository the holder owns, accessed with the holder's fine-grained token that is
  stored only inside the encrypted wallet): `vledger/<walletId>/wallet.json` (`{walletId, createdAt, keyring}`) and
  `vledger/<walletId>/records/<id>.json` (one envelope or tombstone per file). An erasure overwrites the record file
  with its tombstone; the repository history still holds the old ciphertext, which stays unreadable without the key
  (the wallet tells the holder this).

## 9. Event receipts (peer agreement)

```json
{ "type": "aevri.vledger.receipt", "version": 2, "receiptId": "<uuid v7>", "occurredAt": "...",
  "parties": [ { "role": "actor", "key": {"alg": "Ed25519", "x": "..."} }, { "role": "affected", "key": {} } ],
  "action": { "digest": "sha256:...", "type": "optional" },
  "objects": [ { "digest": "sha256:...", "type": "thing" } ],
  "plan": [ { "object": 0, "digest": "sha256:..." } ],
  "arbiters": [ { "party": 0, "url": "https://...", "key": {} } ],
  "mandate": { "mode": "attest" } }
```

Digests: SHA-256 of JCS `{salt, text}` (action) or `{salt, label, quantity, unit, note}` (object), 16-byte random salt
shared by the parties. Each party signs the 32 digest bytes; **matched** when all parties signed the same digest; a
`binding` mandate exists only if all signed it.

## 10. Arbiters

`openapi/arbiter.yaml`, `schema/arbiter.schema.json`: stamps over digests and key thumbprints; lookups only by
parties; cases with disclosed receipts; rulings `attest`, `opinion`, `binding`; a binding ruling is accepted only
from the arbiter named in the binding mandate of a matched receipt. Stamps and rulings are signed over the JCS form
without `sig`.

A case is opened by a party that proves its key (the same proof headers as for lookups) and discloses the receipt
with the signatures. The arbiter answers `409` to a request for a decision when the receipt has no binding mandate
naming it, signed by every party. The wallet keeps a ruling only after checking: the arbiter signature, the receipt
digest, and for a binding ruling the mandate. A ruling from the ÆVRI arbiter follows the published rules
(`/tools/vledger/arbiter-rules/`).

## 11. Messages and relays

```json
{ "type": "aevri.vledger.message", "version": 1, "id": "<uuid v7>",
  "to": "vw1:...", "from": "vw1:...", "sentAt": "...",
  "epk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." }, "iv": "...", "ct": "...",
  "sig": "..." }
```

- Content key: ECDH(ephemeral, recipient `encKey`), then HKDF-SHA-256 (salt 32 zero bytes, info
  `aevri.vledger/1|message|<id>|<to>`); content = AES-GCM of the JCS form of the inner body, AAD
  `aevri.vledger/1|message|<id>|<to>`.
- `sig`: the sender's identity key over the JCS form of the outer message without `sig`. Anonymous messages omit
  `from` and `sig`.
- Inner bodies (`schema/message.schema.json`), all with `kind`:
  - `share` - an assessment shared with the actor of the event or the owner of the object: `event` (actor, action,
    objects as words, `registryRef?`), `phase`, `gained[]`, `lost[]`, `v?`, `spentV?`, `planGap?`, `publish`
    (`no`, `anonymous`, `named`; the sender's choice, binding on a recipient whose card says `sender-choice`);
  - `request` - a supplier asks for an assessment of an event it knows happened: `{event, system?, plan?}`;
  - `event-offer` - a receipt to sign (section 9);
  - `card` - a signed card, to exchange addresses;
  - `suggestion` - events proposed by a device or agent (section 13).
- **Request blocking.** A wallet MUST drop a `request` silently when `settings.requests.blockAll` is true, when the
  sender's address belongs to a contact in `blockContacts`, or when the request names a system (by `registryUrl` or
  title) that maps to a system in `blockSystems`. The sender learns nothing.
- **Event offers** carry, besides the receipt and the sender's signature, an `opening` (the salts and texts behind
  the action and object digests, the parties' roles and the time) so that the other party can see what it is asked to
  sign. The opening travels only inside the encrypted message, never to an arbiter.
- **Card directory** (optional, `openapi/relay.yaml`): a holder MAY publish the signed card at a relay so that others
  who have only the address (from a QR code) can fetch the card and send encrypted messages. The relay verifies the
  card signature and the address; removal needs a wallet proof. Publishing is the holder's choice; nothing is
  published by default.
- **Relays** (`openapi/relay.yaml`) accept messages for an address and hand them to the address holder after a
  key-possession proof. A relay MUST NOT keep a message after delivery or longer than 14 days, MUST NOT log content,
  and cannot read messages.

## 12. Registries of objects and events

An organisation or a state body MAY publish a signed **registry** (`schema/registry.schema.json`): its card, its
value systems and items:

- `object` - something others use (a road, a product, a service): `itemId`, `title`, `system`, `plan` (`promise`,
  `plannedV?`), `actions` it suggests ("walk on", "use");
- `event` - something that happened and affected people ("built the road"), with `affects` in words and a plan;
- `references` - public reference assessments per system (`{system, phrase, v, words}`).

A wallet that adds an event from a registry stores `registryRef = {registryUrl, itemId, owner}` and MAY share
assessments with `owner`. A registry MUST NOT make an assessment a condition of anything.

## 13. Suggested events (devices, agents, "second brain")

A device or agent proposes events with a `suggestion` message or an import file. The wallet stores them with
`status: suggested` and `suggestedBy` = the device's contact, and shows them in the inbox until the holder confirms or
rejects each. Raw recordings stay with the device; the wallet keeps the event text and a source reference only.
A provider that offers events continuously does so as an event stream (section 20).

## 14. Analytics

Computed on the device from confirmed events: counts, assessed counts, sums of `v` and `spentV`, efficiency, plan
gaps, grouped by action type, contact, value system, role and period. Nothing is sent.

## 15. Conformance

A conforming wallet validates documents against `schema/`; never stores or sends plain text except a readable export
the holder asked for; verifies the chain on import; and reproduces every fixture in `fixtures/` (open with the test
passphrase, decrypt and verify messages, check receipts, stamps, rulings, the registry and cards, recompute `w`, `v`,
`spentV`, `e`, plan factors, request blocking and the retro rule).

## 16. Bridges to VET and VSS (stage L4)

The wallet, VET (Value Estimation Tool) and VSS (Value Stream Schema editor) stay separate tools. They talk only
through `postMessage` between a page and the page it embeds in an `iframe`, on the same origin: each side checks
`event.origin === location.origin` and `event.source` (the frame it opened, or `window.parent`), and posts to
`location.origin`, never `*`. A message is an envelope `{protocol, version: 1, type, requestId, payload}`; a reply
carries the `requestId` of the request; replies to another `requestId` are ignored. `schema/bridge.schema.json`
describes the payloads. Nothing in a bridge is sent to a server.

### 16.1 Estimating an event in VET (the wallet hosts VET)

Envelope `protocol: "aevri.vet"` (the protocol VET already speaks with VSS).

1. The wallet opens `/tools/vet/embed.php?host=ledger` and waits for `vet.ready {capabilities}`. VET that supports
   this mode lists `ledger-receiver-v1`; without it the wallet says VET cannot estimate events yet and closes.
2. The wallet sends `ledger.open`:
   `{mode: "receiver", ledgerRef: {ledgerId, entryId, assessorId}, title, items: [{title, ledgerRef, typeName?}],
   axes: {out: {label}, in: {label}}, lang, extensions: {aevriLedger: {schemaVersion: "1.0", boardSnapshot?, boardId?}}}`.
   `ledgerId` is the wallet id, `entryId` the event root id, `assessorId` the wallet address. One item per object of
   the event, or one item named after the action when the event has no objects. The out axis is what the holder
   received (it may be negative: harm), the in axis what receiving it cost the holder. Labels are in the holder's
   language. A repeated `ledger.open` with the same `requestId` MUST NOT create a second board.
3. VET shows a board with exactly these items (the holder may add more; it never shows other people's items) and
   answers `vet.result`: `{boardId, ledgerRef, items, totals, axes, extensions: {aevriLedger: {schemaVersion: "1.0",
   resultId, resultRevision, boardSnapshot}}}`, where `items` and `totals` are as in the VSS result. Or `vet.cancel {}`,
   which changes nothing.
4. The wallet checks that `ledgerRef` is the one it sent and keeps the result in the assessment it is editing as
   `vet: {boardId, resultId, revision, totals, axes, receivedAt, snapshotHash, boardSnapshot}`, `snapshotHash` being
   `sha256:` of the JCS form of `boardSnapshot`. Opening VET again for the same event sends the stored snapshot, so the
   same board continues (key `{ledgerId, entryId, assessorId}`, not the VSS key `{vssSchemaId, flowId}`).
5. VET totals are on the holder's own VET scales. The wallet shows them next to `v` and `spentV` and MAY offer them as
   `ownScore`; it MUST NOT convert them into `v` silently.

### 16.2 Transfers of a VSS flow (VSS hosts the wallet)

Envelope `protocol: "aevri.vledger"`. VSS opens `/tools/vledger/?embed=vss` in an `iframe`; the wallet page sends
`Content-Security-Policy: frame-ancestors 'self'`, so only pages of the same site can embed it. The holder opens or
creates the wallet inside the frame as usual; the passphrase never leaves the frame.

- `ledger.ready {capabilities: ["transfers-v1"]}`: sent by the wallet once a wallet is open (not before).
- `vss.transfer.open {transferContext}`: VSS asks to record a transfer along a flow. `transferContext` is
  `{flowRef: {vssSchemaId, flowId, flowLabel?, sourceNode?: {name}, targetNode?: {name}}, elementType?: {id, name,
  kind}, item?: {boardId, itemId, title}}`. It only pre-fills the event dialog; the holder confirms or cancels.
  The event keeps `vssRef: {vssSchemaId, flowId, flowLabel?, elementTypeId?, item?}`.
- `ledger.transfer.saved {ledgerRef: {ledgerId, entryId}, summary}` or `ledger.cancel {}`.
- `vss.transfers.list {flowRef}` -> `ledger.transfers {flowRef, transfers: [{ledgerRef, summary}]}`: the events of
  this wallet with that `vssRef`.
- `vss.transfer.summary {entryId}` -> `ledger.transfer.summary {ledgerRef, summary}`.

`summary` is what the holder allowed (`settings.bridges.vss.share`): by default `"fact"`, that is `{occurredAt,
role, assessed: boolean}`; with `"value"` also `{v, spentV, phase}` of the latest assessment. VSS shows transfers as
their own layer and never adds them to its planned VET estimate. Estimates stay in the wallet; VSS never edits them.

## 17. One-click reactions (d6)

An assessment MAY carry `reaction`, one of -100, -20, 0, 20, 100, 500 (harmed me, lost my time, neutral,
interesting, hooked, I will apply it): the scale readers use on the institute site. A reaction alone is a complete
assessment; it is not converted into `v`. When the holder has goals, a wallet SHOULD offer to calibrate reaction-only
assessments by adding `contributions`, which then give `v` as usual.

An assessment MAY carry `comparison`: `{referenceEventId, referenceTitle, polarity: benefit | harm, ratio: 0.5 | 1 | 2 | null
(hard to compare), refV?, estV?}`. When the reference has a goal value `refV`, `estV = ±|refV| x ratio` is an approximate
estimate shown as "≈"; it is never written into `v`, which stays the goal value. Without `refV` the comparison stays
relative ("about twice X"). A value system made from a registry keeps
`registryUrl` and `registrySystemId`, one per system of that registry.

## 18. Unlock with device biometrics (d7)

A wallet MAY open on one device without the passphrase, by the device's own biometrics or PIN, using a WebAuthn
passkey with the PRF extension made on that device (`userVerification: required`, platform authenticator). The PRF
output for a random 32-byte salt gives `kek = HKDF-SHA-256(prf, salt 0^32, info "aevri.vledger/1|device-unlock|<walletId>|<credentialId>")`,
and the data key is kept as `seal(kek, dek, "device-unlock", walletId, credentialId)`. The record
`{walletId, credentialId, salt, rpId, wrap, createdAt}` stays on that device, outside the wallet document: it is never
synced or sent to a provider, so only that device can use it. The passphrase slot stays the master key. Where the
browser gives no PRF result, a wallet MUST NOT offer a biometric gate without a key and keeps the passphrase.

## 19. A sphere and its VSS schemas (d8)

A value system (sphere) MAY link VSS schemas: `vss: [{schemaId, title, holderNodeId, nodeContacts, source}]`.
`holderNodeId` is the node that stands for the holder; `nodeContacts` maps other nodes to contacts. A copy of the
schema document (`aevri.vss`) is kept as an `import` record with `originId` `vss:<schemaId>`, so the map works
offline and from a file. The map of a sphere shows the holder node and its neighbours; a flow counts the events of
the sphere whose `vssRef.flowId` is that flow; flows without events are shown as expected, not as zero value.

## 20. Event streams (d9)

An **event stream** is a source that notices events and offers them to the people who took part: a "second brain"
that transcribes the holder's meetings and calls, a calendar, a smart home, an employer's task tracker, a city's road
works, the institute's publications. The service or device behind it is the **stream provider**; a wallet that
connected to it is a **subscriber**. Reviewed with Codex and Grok Heavy (`docs/VLEDGER/streams/`).

### 20.1. The main rule

A provider only **suggests**. Every event lands in the wallet as `status: suggested` (section 13) and reaches the
timeline only when the holder confirms it, one by one or by a rule the holder made (20.7). The provider never writes into a wallet, never reads it, and learns
nothing about what the holder did with an event: no confirmations, rejections, reactions or assessments go back
automatically. The holder MAY share an assessment, a participation or a new event with a stream, each time by their
own action (20.11), and MAY run a stream of their own (20.12).

Providers and relays can still see connection and delivery metadata (addresses, times, sizes). Per-stream keys
(20.4) keep two providers from linking one holder by key, but they do not hide an identity a provider already knows
from its own accounts, voices or devices. Providers MUST NOT correlate subscriptions or profile holders.

### 20.2. The stream descriptor

A provider describes a stream with a signed descriptor (`schema/stream.schema.json`):

```json
{ "stream": {
    "type": "aevri.vledger.stream", "version": 1, "descriptorRev": 1,
    "streamId": "<uuid v7>", "title": "2dBrain: my meetings and calls",
    "provider": { "name": "2dBrain", "kind": "device", "address": "vw1:...",
                  "encKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." } },
    "access": "open | code | attested",
    "transport": ["https", "relay"],
    "endpoint": "https://example.org/vledger-stream/v1",
    "relay": "https://aeilus.institute/api/v1/vledger/relay",
    "identifies": "provider | holder", "audience": "participants | selected-readers | public",
    "eventKinds": ["meeting", "call", "message", "task", "visit", "publication", "other"],
    "policy": { "keeps": "events and transcripts, on the provider's own machine", "retentionDays": 365,
                "deletesOnLeave": true, "rawStays": true, "url": "https://example.org/privacy" },
    "feedback": { "accepts": ["assessment", "participation", "event"], "...": "20.11" },
    "updatedAt": "2026-10-19T09:00:00Z" },
  "sig": "<provider identity key over JCS of stream>" }
```

- `provider.address` (section 3) names the provider key; it signs the descriptor and every event. `encKey` receives
  encrypted messages from subscribers.
- `access`: `open` - anyone may read, events are the same for everyone, signed but not encrypted (a city, a newsroom,
  the institute's publications); `code` - private: a one-time **pairing code** is shown on a screen only the
  provider's owner sees (an app on the holder's phone, an admin page inside a home network or VPN). A provider MAY
  protect that screen with its own login; the wallet never sees it. `account` (sign in at the provider and come back
  with a code) is reserved for a later draft.
- `transport`: `https` - the wallet pulls from `endpoint`; `relay` - provider and wallet exchange encrypted messages
  (section 11) through `relay`, so a provider at home needs no inbound port and the wallet page no direct connection.
  A provider MUST offer at least one. Using a relay is disclosed to the holder before connecting; a stream that must
  stay inside a private network uses `https` only, with a TLS certificate the holder's browser trusts.
- `identifies`: `provider` - the provider knows which participant is the subscriber and marks it; `holder` - it does
  not, and the holder finds themself in the wallet (20.6). Open streams use `holder`.
- Names and policies are the provider's claims. The wallet shows them as such, with the descriptor's origin and the
  key fingerprint, and pins the provider address and `streamId` it connected to. A descriptor with a different key
  needs a new connection; a higher `descriptorRev` that changes the endpoint, relay, access or policy needs the
  holder's approval; a lower `descriptorRev` is ignored.

### 20.3. Connecting: a QR code or a link

```
https://aeilus.institute/tools/vledger/#stream=<descriptor URL>&code=<pairing code>
https://aeilus.institute/tools/vledger/#stream=vw1:<provider address>&code=<pairing code>&relay=<relay URL>
```

The first form names a descriptor at an HTTPS URL (CORS open to the wallet origin). The second serves providers
reachable only through a relay: the wallet takes the provider's card from the relay's card directory (section 11),
and the provider sends the descriptor in its `subscribed` reply. `relay` defaults to the institute relay. Parameters
are percent-encoded and travel in the fragment, so they never reach a web server; `/w/` links work the same way. A
QR code holds the same link. A wallet MUST also accept the link pasted as text.

The wallet then:

1. fetches and verifies the descriptor (or the card), and removes the pairing code from the address bar and history;
2. shows what will happen: title, provider and fingerprint, what kinds of events it suggests, how it identifies the
   holder, its policy, the transport (and that a relay sees delivery times), and "nothing goes back automatically";
3. on the holder's tap **Connect**, creates a **subscription key pair** for this stream on this device (Ed25519 to
   sign, P-256 to receive) and subscribes (20.4).

Nothing is connected without that tap.

### 20.4. Subscribing

Open streams need no subscription: the wallet only pulls. For `code` streams:

- The wallet sends `{kind: "subscribe", streamId, code, subscriber: {address, encKey}, proof}`, where `address` is
  the `vw1:` form of the subscription key and `proof` is its signature over the JCS form of
  `{purpose: "aevri.vledger/1|subscribe", providerAddress, streamId, code, subscriber}`. Over `https`:
  `POST {endpoint}/subscriptions`; over the relay: an encrypted message (section 11) to `provider.address`, signed by
  the subscription key. When the link named only the provider address, the wallet does not know the stream yet:
  `streamId` is left out of the request and of the proof, and the code says which stream it is.
- The provider checks the code (at least 128 random bits, at most 10 minutes old, used once, consumed atomically),
  then shows the first 8 characters of the subscription key fingerprint on its own screen; the wallet shows the same
  8 characters. A **fingerprint** of an address is base32 (RFC 4648, `A-Z2-7`, no padding) of SHA-256 of the
  address text; the wallet shows the provider's fingerprint the same way. The owner approves on the provider side if they match. The answer is
  `{kind: "subscribed", streamId, subscriptionId, descriptor?}`; a repeated identical request returns the same answer.
- The provider binds the subscription to what the pairing screen belongs to (its owner, a participant). It MUST NOT
  ask for, accept or store the holder's main wallet address, name, contacts or anything from the wallet.
  Subscribing discloses only the subscription fields and, where a stream requires them, attestations the holder
  approved (20.13); it never gives access to the wallet. Feedback the holder sends separately (20.11) is allowed.
- Subscription keys stay on the device where they were made, in encrypted device-local storage, outside the wallet
  document (like section 18): they are never synced or exported. Another device of the same holder connects to
  an open stream by itself and to a private stream with its own pairing. The stream record itself (20.8) is synced, so all devices know the stream and
  which events were already handled; it lists each device's subscription (`subscriptions[]`: id and address, never
  keys).

### 20.5. Events

```json
{ "type": "aevri.vledger.stream-event", "version": 1,
  "streamId": "...", "eventId": "<provider's stable id>", "rev": 1, "recipient": "vw1:<subscription address>",
  "occurredAt": "2026-10-19T09:30:00Z", "approx": false, "until": "2026-10-19T10:15:00Z",
  "kind": "meeting",
  "actor": { "ref": "p1", "label": "Anna" },
  "action": "agreed the pilot plan",
  "objects": [ { "label": "pilot plan for Q4", "type": "decision" } ],
  "participants": [ { "ref": "p1", "label": "Anna", "role": "actor" },
                    { "ref": "p2", "label": "Victor", "role": "affected", "you": true } ],
  "summary": "Short text, at most 1000 characters",
  "source": { "label": "Call recording, 19 Oct", "url": "https://..." },
  "confidence": 0.8, "withdrawn": false,
  "sig": "<provider key over JCS without sig>" }
```

- `ref` is an opaque participant id, stable inside the stream and never reused for someone else. `you: true` appears
  only in private streams with `identifies: provider`, on exactly one participant; `recipient` is required there and
  is absent in open streams. Object `type` is a label, not the holder's element type.
- `rev` is a positive integer that grows with every correction; `withdrawn: true` (at a higher `rev`) takes the event
  back.
- Raw recordings, transcripts and media stay with the provider (section 13). An event carries words and at most a
  link back.
- **Pull** (`https`): `GET {endpoint}/events?after=<cursor>` answers `{events, cursor}` with at most 100 events.
  Private streams prove the subscription: `GET {endpoint}/challenge` gives a one-time challenge (5 minutes), and the
  request carries `X-Vledger-Address`, `X-Vledger-Challenge` and `X-Vledger-Proof`, a signature by the subscription
  key over the JCS form of `{purpose: "aevri.vledger/1|stream-request", challenge, method, pathAndQuery, streamId,
  subscriptionId}`. Private events come as messages (section 11) encrypted to the subscription `encKey`. Requests
  omit cookies.
- **Push** (`relay`): the provider sends `{kind: "stream-events", events: [...]}` messages to the subscription
  address. A relay deletes a message once it is fetched and after 14 days at most, so delivery is best effort: the
  provider keeps its events and resends them when the wallet asks with `{kind: "replay", streamId, since}`.
- Limits for the pilot: descriptor 16 KiB, event 32 KiB, response 1 MiB, JSON depth 16, 100 participants and 100
  objects per event; at most 1 000 pending suggestions per stream (beyond that the wallet pauses the stream and says
  so).

### 20.6. Finding yourself

- `identifies: provider`: the participant with `you: true` gives the holder's role (`actor`, `affected`, `user`,
  `witness`). A private stream sends only events in which the subscriber took part.
- `identifies: holder` (open streams): the provider sends the events meant for everyone and the wallet matches them
  locally and ignores any `you` flag. When an event lists participants, the wallet asks once "Which of these is you?" and remembers the answer
  for that `ref`; events without the holder can still be kept as "I was there" or "it affects me" by the holder's
  choice. The provider is never told.
- Other participants are mapped to the holder's contacts by the holder ("Anna in 2dBrain is my contact Anna"); an
  unmapped actor is resolved before the event is confirmed. The map stays in the wallet.

### 20.7. Review, rules and corrections

1. The wallet verifies the signature against the pinned key and drops anything else, including events for another
   `recipient`.
2. It keeps one state per `(provider address, streamId, eventId)`: a lower or equal `rev` is ignored (different
   content at the same `rev` is set aside as suspicious); a higher `rev` replaces a pending suggestion; for a
   confirmed event the wallet only says "the provider corrected this" and the holder may accept the change as a
   correction (section 6). A withdrawal removes a pending suggestion and flags a confirmed event, never deleting the
   holder's record. Rejections are remembered, so a correction never brings a rejected event back.
3. A suggestion is stored with `source: "stream"`, `suggestedBy` = the provider's contact and
   `streamRef = {provider, streamId, eventId, rev}`. The review queue groups suggestions by stream, day and
   participant and offers **Confirm**, **Confirm and rate** (section 17) and **Reject**, one at a time or for a group.
4. **Rules.** The holder MAY create a rule from events they confirmed by hand ("always confirm 2dBrain calls with Anna").
   Rules live in the wallet, are made only by the holder, only confirm (they never rate), mark what they confirmed as
   "by rule", are listed in a short daily summary, and can be undone in one tap for everything they did. Nothing about rules leaves the wallet.

### 20.8. The stream record, pausing and leaving

A payload kind `stream`: `{providerAddress, streamId, descriptorUrl?, descriptor (signed, as received),
subscriptionId?, cursor?, selfRefs[], contactMap[], rules[], handled[] ({eventId, rev, state}), paused, addedAt}`.
Subscription keys are not in it (20.4).

- **Pause** stops taking in events on all devices; the provider may still send.
- **Leave**: `DELETE {endpoint}/subscriptions/{subscriptionId}` with the subscription proof, or an `unsubscribe`
  message by relay. The provider MUST stop sending and, when its policy says `deletesOnLeave`, delete what it keeps
  for that subscription, then answer `unsubscribed`, signed with its key, as a receipt. Until that answer comes, the wallet shows the leave as pending
  and keeps retrying; the holder may also forget the stream at once. Events already confirmed stay in the wallet.

### 20.9. What a provider promises

A conforming provider:

1. signs the descriptor and every event with one key and states its policy in the descriptor;
2. sends private subscribers only events in which they took part, and open streams only events meant for everyone;
3. never asks for the holder's main address, contacts, assessments or anything else from the wallet, and never makes
   an assessment a condition of anything (as registries, section 12);
4. keeps raw recordings to itself and sends words, not media;
5. does not correlate subscriptions or profile holders, and keeps no more delivery data than it needs;
6. stops at Leave and keeps its deletion promise;
7. if it accepts feedback, follows its stated feedback policy, honours withdrawals and never makes feedback a
   condition of anything (20.11).

### 20.10. Security

- Text in descriptors and events is untrusted: a wallet shows it as text, never as markup, never follows
  instructions in it and never prefetches links; it opens an `https` source link only on the holder's tap, showing
  the destination, without referrer or opener.
- Pairing codes stay in memory: the wallet clears them from the address bar and history and never logs them.
- A web page served over HTTPS cannot reliably reach plain `http` addresses in a home network; home providers use the
  relay or HTTPS with a trusted certificate. Test both the browser and the Android app.
- Providers rate-limit pairing and delivery; wallets bound concurrency, back off on errors and move the cursor only
  after the events are stored.

### 20.11. Sharing back with a stream

A stream MAY accept **feedback** from people: an assessment of one of its events, "I took part in this", or a new
event the stream does not know yet ("I used the new road"). Nothing is sent by itself: each sending is the holder's
own action, after the wallet has shown the stream's feedback policy, the sender form and exactly what will go. Local
confirmations, ratings and rules never authorise sending.

The descriptor announces it:

```json
"feedback": {
  "accepts": ["assessment", "participation", "event"],
  "senders": ["anonymous", "subscriber", "named"],
  "moderation": "none | before | after",
  "publishes": "no | anonymous | named | sender-choice",
  "retentionDays": 730,
  "rulesUrl": "https://example.org/feedback-rules" }
```

- `publishes` has the meaning of the storage policy of a card (section 3). With a fixed policy an item's `publish`
  MUST match it and other items are refused; with `sender-choice` the item's `publish` binds the owner. Where the
  provider also has a card, a card and a descriptor that disagree block sending. A later policy never widens what
  was allowed for items already sent.
- `moderation` is only about timing: `none` - published as sent; `before` - the owner approves first; `after` -
  published at once and may be removed. It never overrides `publishes`. How the owner moderates is the owner's
  business; the descriptor says which, and `rulesUrl` says by what rules.
- `senders`, how a sender may appear:
  - **anonymous** - signed by a key made for this one item. This is a pseudonym for one item, not a promise of
    anonymity: the words, a reference to a private event or network metadata may still point to the sender, and the
    wallet says so. The message carries no subscription proof, card, cookie or `from`;
  - **subscriber** - signed by the subscription key (20.4). It links the item to the subscription, to the sender's
    other feedback in this stream and to anything the provider already knows about the subscriber; the wallet says
    so before sending;
  - **named** - signed by the wallet identity key, with the sender's signed card.
  The wallet offers only the forms the stream accepts and starts with the most private one.

A feedback item (`schema/stream.schema.json#/$defs/feedback`) goes as an encrypted `stream-feedback` message
(section 11) to `provider.address` through the relay, or encrypted the same way by `POST {endpoint}/feedback`:

```json
{ "kind": "stream-feedback", "version": 1, "feedbackId": "<uuid v7>",
  "providerAddress": "vw1:...", "streamId": "...", "descriptorRev": 3,
  "type": "assessment | participation | event",
  "about": { "eventId": "...", "rev": 2 },
  "event": { "action": "used", "objects": [ { "label": "the new road to Kolossi" } ],
             "occurredAt": "2026-10-19", "place": "Kolossi" },
  "role": "user",
  "assessment": { "phase": "realized", "reaction": 100, "gained": ["20 minutes a day"], "lost": [],
                  "words": "Smooth and safe, but no lighting at night", "planGap": "below-plan" },
  "publish": "no | anonymous | named",
  "sender": "anonymous | subscriber | named", "card": { },
  "key": "vw1:...", "replyEncKey": { "kty": "EC" },
  "sentAt": "...", "sig": "<the sender key over JCS without sig>" }
```

- `assessment` and `participation` need `about` (an event of the stream); `event` needs `event` and MAY carry an
  `assessment`. `role` is the sender's role. `card` is required for, and allowed only with, `named`.
- An assessment carries only what the holder chose: a one-tap `reaction` (section 17), words, gained and lost,
  `planGap`, and `v` or `spentV` only if the holder ticks them. Goals, the holder's scale and other records never go.
- Participation and new events are the sender's claims; approving them in moderation does not verify them.
- **Receipts.** The provider answers with a signed `feedback-receipt` `{providerAddress, streamId, feedbackId,
  itemHash, statusRev, status: "received" | "pending" | "published" | "rejected" | "withdrawn", url?, reason?}`,
  encrypted to `replyEncKey` and, over the relay, addressed to `key`. The sender may ask `{kind: "feedback-status"}`
  or withdraw with `{kind: "feedback-withdraw"}`, both signed by `key` over `{kind, providerAddress, streamId,
  feedbackId, requestId}`. The wallet keeps the item key, encrypted, for as long as it keeps the item, also after
  leaving the stream.
- **Withdrawal** is final and may be repeated safely: the provider removes the item from everything it publishes and
  caches, deletes it as its retention policy says, keeps only a small tombstone so the item cannot be published
  again, and answers `withdrawn`. Copies others already made are out of its reach; the wallet says so.
- The wallet keeps a `message-out` record for every item (`about` = the event) and its receipts, so the holder sees
  what went to whom and its status. Items are deduplicated by `(providerAddress, streamId, key, feedbackId)`; the
  limits of 20.5 apply. Batches are left for a later draft.
- A provider MUST NOT make feedback a condition of anything, treat silence as an assessment, try to find out who an
  anonymous sender is, or use persistent fingerprinting. It MAY switch anonymous feedback off, or accept it with
  moderation, size limits, rate limits and bounded queues. A fresh key proves neither a unique person nor
  participation, so counts of items MUST NOT be shown as counts of people, and personal `v` values MUST NOT be put on
  a common scale or turned into scores or rankings of people.

### 20.12. Your own stream

A holder MAY run a stream: to publish their own assessments of events (`access: open`, `audience: public`), or to
share events and assessments with chosen people (`access: code`, `audience: selected-readers`). Streams of providers
that suggest events to the people who took part have `audience: participants` (the default). Being chosen as a
reader gives access, not a role in the events: a personal stream never marks anyone `you`.

- The holder's device keeps the stream's signing key and the keys to decrypt subscription requests, approves each
  reader, and encrypts private events separately for every approved reader (bound by `recipient`, 20.5).
- Because the wallet lives on a device, a **stream host** keeps the signed events and serves `endpoint` (the
  institute provider MAY do this; it is optional). The host receives only the public events or the private
  ciphertext, never wallet keys or records. Signatures show any change, but a host can still leave items out, delay
  them or see metadata; it MUST NOT add readers, publish private content or keep more than its disclosed policy says.
- A `named` personal stream proves who runs it: the identity key signs `{purpose: "aevri.vledger/1|stream-owner",
  streamId, streamAddress}` and the descriptor carries that proof with the holder's card. A card alone proves nothing.
- An event in a personal stream MAY carry the holder's `assessment` in the 20.11 form. It stays the author's
  assessment: a reader who confirms the event does not adopt it.
- What goes into the stream is the holder's choice, item by item. A rule ("my reactions to road works") MAY prepare
  a list, which the holder approves before it is sent. Withdrawing follows 20.11.
- To share one assessment with one person, the `share` message (section 11) is enough; a personal stream is for
  sharing that continues.

### 20.13. Closed streams and verified people (d10)

A stream often needs to know *what kind* of person it talks to, not *who*: only the members of a department, only
residents of a town, or only people with a checked account at the institute. An **attestation** says exactly that
about one key, and nothing more.

```json
{ "attestation": {
    "type": "aevri.vledger.attestation", "version": 1,
    "issuer": "vw1:<issuer key>", "issuerName": "ÆVRI",
    "subject": "vw1:<the key it speaks about>",
    "claim": "account-verified",
    "audience": { "providerAddress": "vw1:...", "streamId": "..." },
    "issuedAt": "2026-10-19T10:00:00Z", "expiresAt": "2026-11-18T10:00:00Z" },
  "sig": "<issuer key over JCS of attestation>" }
```

- **Issuers** sign claims they checked themselves, never claims a requester merely asks for. The institute issues
  `account-verified`: a signed-in site account with a confirmed e-mail address. That proves neither a legal identity,
  nor a unique human, nor taking part in an event. An employer may issue `member:<unit>`, a town `resident:<place>`.
  An issuer publishes a signed card (section 3) and its attestation policy: how it checks, what it keeps and for how
  long.
- **Subject** is a key made for this stream: the subscription key (20.4) or the one-time key of a feedback item
  (20.11); the holder's main wallet address only when the holder sends as `named`. The stream learns "a checked
  account" or "a member of the unit", not who it is.
- **This is pseudonymity towards the stream, not anonymity towards the issuer.** The issuer knows which of its
  accounts a key belongs to, and the `audience` tells it which stream the key is for; the protocol never sends it what
  is sent with the key. An issuer and a provider working together could identify the holder. Issuers keep as little
  as they can, say how long they keep it, never profile holders and never hand over the link between keys and
  accounts. The wallet explains this before asking.
- **Getting one** is one tap in the wallet: "Confirm with ÆVRI" (or with the employer). The wallet shows the issuer,
  the claim, the stream and the expiry, and asks the holder. Then it fetches a one-time challenge (5 minutes, bound
  to the signed-in session) and sends `{subject, claim, audience, challenge, proof}`, where `proof` is the subject
  key's signature over JCS `{purpose: "aevri.vledger/1|attest", issuer, subject, claim, audience, challenge}`. The
  institute endpoint is `POST /api/v1/vledger/attest` (with `GET .../attest/challenge`), same-origin, CSRF-protected.
- **Lifetime.** In the pilot an attestation lives at most 30 days and cannot be revoked early by the issuer, so a
  closed account may keep access for up to 30 days. The provider checks validity on every private fetch, replay, push
  and new feedback item, and a subscription ends when its attestation expires, unless the wallet brings a fresh one.
  The stream owner can end any subscription at once. Expiry never removes what was already delivered and never stops
  a sender from withdrawing earlier feedback.
- Copying an attestation gives nothing without the subject's private key.

The descriptor states one issuer and one claim per requirement:

```json
"access": "attested",
"requires": { "issuer": "vw1:<employer key>", "claim": "member:datsteam-dit" },
"feedback": { "...": "20.11", "requires": { "issuer": "vw1:<ÆVRI key>", "claim": "account-verified" } }
```

- The stream owner trusts that issuer key for that claim only; a name or a self-signed card gives no authority.
  Access and feedback requirements are independent. Changing them follows the descriptor approval rules of 20.2.
- **Closed stream.** `access: "attested"` needs no pairing code: the link or QR code is enough. The wallet fetches a
  challenge from the provider and subscribes with `{kind: "subscribe", streamId, challenge, subscriber,
  attestations, proof}`, where `proof` signs JCS `{purpose: "aevri.vledger/1|subscribe-attested", providerAddress,
  streamId, challenge, subscriber, attestationHashes}`. The provider checks the issuer signature, the issuer and claim
  against `requires`, type, version, validity, `audience` and that `subject` is the subscriber address. A `code`
  stream MAY require attestations as well. Attested access lets a person read; it does not prove taking part and does
  not publish anything. Readers of a personal `selected-readers` stream are still approved one by one (20.12).
- **Verified feedback.** With `feedback.requires`, an `anonymous` item carries an attestation about its one-time key
  and a `subscriber` item one about the subscription key; the item signature covers `attestations`. When feedback is
  published anonymously, the stream publishes neither the attestation nor the key.
- Three levels the wallet shows before sending: **anyone** (no attestation), **checked, not named** (an
  attestation), **named** (identity key and card; the card is the holder's own claim, not a checked identity).
- Deferred beyond the pilot: "one voice per person", several issuers per requirement, early revocation.
