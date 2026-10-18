# Value Wallet format and protocols - `aevri.vledger` 1.0

Status: **draft 1.0-d8** (2026-10-18). Editor: Aeilus Value Research Institute (ÆVRI).
Licence: CC BY 4.0 (this text), MIT (reference code and schemas). Requirements (Russian): TZ v0.2 and v0.3.
Fixtures in `fixtures/` are produced by `reference/` (Web Crypto) and pass the independent `tools/verify_fixtures.py`.
Changes from d7: spheres link VSS schemas and show them as a map (section 19).
Changes from d6: unlock with device biometrics (section 18), kept on the device, outside the wallet document.
Changes from d5: one-click `reaction` in assessments (section 17); `registrySystemId` in value systems.
Changes from d5: one-click `reaction` in assessments (section 17); `registrySystemId` in value systems.
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
`registry`, `message`, `device`, `agent`, `vet`, `vss`, `aevri.site`, `aevri.vvp`.

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

## 17. One-click reactions (d6)

An assessment MAY carry `reaction`, one of -100, -20, 0, 20, 100, 500 (harmed me, lost my time, neutral,
interesting, hooked, I will apply it): the scale readers use on the institute site. A reaction alone is a complete
assessment; it is not converted into `v`. When the holder has goals, a wallet SHOULD offer to calibrate reaction-only
assessments by adding `contributions`, which then give `v` as usual. A value system made from a registry keeps
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
