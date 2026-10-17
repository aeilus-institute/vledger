# Value Wallet format and protocols - `aevri.vledger` 1.0

Status: **draft 1.0-d1** (L0, 2026-10-17). Fixtures in `fixtures/` are produced by `reference/` (Web Crypto) and pass the independent `tools/verify_fixtures.py` (Python). Editor: Aeilus Value Research Institute (ÆVRI).
Licence: CC BY 4.0 (this text), MIT (reference code and schemas). Russian requirements: `../AEILUS_VLedger_TZ_v0.2.md`.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. What this is

A **value wallet** is a person's own encrypted record of value exchanges: who they exchanged with (people,
organisations, the state), what elements passed each way, what the giver promised (planned value), what the holder
expected, received and lost, how much each element moved the holder's own goals, and which facts matter for those
goals.

Design commitments:

1. **The holder owns it.** It lives on the holder's device by default. Storage providers and arbiters are chosen by the
   holder and are replaceable.
2. **Always encrypted.** Nothing in the wallet is stored in plain text, on the device, at a provider or in an export,
   unless the holder explicitly asks for a readable export.
3. **No common register.** The truth about an exchange is that both parties hold the same signed receipt. An arbiter
   keeps only digests and times, never content, unless the parties disclose it.
4. **No scores of people.** Value is not transferable and is never summed into a score of a person. What can be shared
   is an assessment of an exchange.
5. **The holder's own scale.** Any numbers in any units. Comparability comes from goal weight and contribution
   (section 7), not from a common unit.

A system where the arbiters and providers are fixed for everyone is a register, not a wallet. This specification
describes a wallet; a register MAY reuse the formats.

## 2. Building blocks

| Item | Choice |
| --- | --- |
| Identifiers | UUID version 7, lower case, as strings |
| Time | RFC 3339 in UTC with `Z` |
| Binary in JSON | base64url without padding (RFC 4648 section 5) |
| Canonical JSON for hashing and signing | JSON Canonicalization Scheme, RFC 8785 (JCS) |
| Hash | SHA-256, written `sha256:<64 hex>` |
| Symmetric encryption | AES-256-GCM, 12-byte random IV, 128-bit tag |
| Passphrase KDF | PBKDF2-HMAC-SHA-256, at least 600 000 iterations, 16-byte salt; `argon2id` MAY be used where available (ADR-001) |
| Signatures | Ed25519 (`alg: "Ed25519"`); `ES256` (ECDSA P-256, SHA-256) MAY be used where Ed25519 is unavailable |
| Public-key encryption (provider recovery) | ECDH P-256 ephemeral-static, HKDF-SHA-256, AES-256-GCM (section 4.4) |
| Public keys in JSON | `{"alg": "Ed25519", "x": "<base64url raw 32 bytes>"}` or JWK for P-256 |

All of these exist in the Web Cryptography API of current browsers, so a wallet can run without a build step or
native code.

## 3. The wallet document

A wallet is one JSON document (file extension `.vledger.json`). Providers MAY store its parts separately (section 8).

```json
{
  "format": "aevri.vledger",
  "version": "1.0",
  "walletId": "0199f0c2-...",
  "createdAt": "2026-10-17T09:00:00Z",
  "keyring": { "...": "section 4" },
  "records": [ { "...": "section 5, encrypted envelopes" } ],
  "extensions": {}
}
```

Readers MUST reject a `format` other than `aevri.vledger` and a major `version` they do not know. Unknown members of
`extensions` and unknown optional members elsewhere MUST be preserved on rewrite.

## 4. Keys and encryption

### 4.1. Key hierarchy

- **DEK** (wallet data key): 32 random bytes. Never stored unwrapped.
- **Key slots** in `keyring.slots[]`: each slot wraps the same DEK for one way of opening the wallet.
- **Record key** (RK): 32 random bytes per record, wrapped by the DEK. Destroying the wrapped RK and the ciphertext
  erases the record (section 6).
- **Identity key**: an Ed25519 key pair used to sign receipts. The private key is stored as a record-like encrypted
  blob in `keyring.identity` (wrapped by the DEK); the public key is in clear in `keyring.identity.publicKey`.

### 4.2. Wrapping

Every wrap uses AES-256-GCM with additional authenticated data (AAD) = UTF-8 bytes of the string

```
aevri.vledger/1|<purpose>|<walletId>|<id>
```

where `purpose` is `slot`, `identity` or `record`, and `id` is the slot id or record id. AAD binds a wrapped key to its
place: a slot or record key copied to another wallet or record fails to open.

A wrapped value is written `{"iv": "<b64u 12 bytes>", "ct": "<b64u ciphertext+tag>"}`.

### 4.3. Slot kinds

| `kind` | Opens with | Notes |
| --- | --- | --- |
| `passphrase` | KEK = KDF(passphrase, salt, params) | Mandatory slot. Mode "only me" = this slot (plus optional `device`) only |
| `device` | A non-extractable platform key | MAY be added for convenience; losing the device loses only this slot |
| `provider-recovery` | The provider's recovery private key | Section 4.4. The wallet MUST tell the holder that in this mode the provider can technically read the wallet |
| `recovery-code` | KEK = KDF(recovery code) | MAY be used for a "2 of 2" scheme together with a provider (COULD, ADR-001) |

Passphrase slot:

```json
{ "id": "s1", "kind": "passphrase",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64u 16>" },
  "wrap": { "iv": "...", "ct": "..." } }
```

Losing every slot's secret loses the wallet. There is no other way in; that is the point of mode "only me".

### 4.4. Provider recovery slot

The provider publishes a recovery public key (ECDH P-256, JWK) with a `keyId`. The wallet:

1. creates an ephemeral P-256 key pair, derives a shared secret with the provider key (ECDH, 256 bits);
2. derives a 32-byte wrapping key with HKDF-SHA-256, salt = 32 zero bytes, info = `aevri.vledger/1|recovery|<walletId>|<keyId>`;
3. wraps the DEK with AES-256-GCM (AAD as in 4.2, purpose `slot`);
4. stores `{ "id", "kind": "provider-recovery", "providerId", "keyId", "epk": <ephemeral public JWK>, "wrap" }`.

The provider recovers by repeating the derivation with its private key, but only through its published procedure
(identity check, delay, notification of the holder on every device, a log entry the holder can read; TZ CR-3). The
procedure is the provider's obligation, not something this format can enforce. A provider's recovery private key
SHOULD be kept offline or in an HSM, apart from the ciphertexts.

## 5. Records

### 5.1. Envelope (what a provider can see)

```json
{ "id": "<uuid v7>", "seq": 17, "prevHash": "sha256:...", "rk": { "iv": "...", "ct": "..." },
  "iv": "<b64u>", "ct": "<b64u>", "ctHash": "sha256:..." }
```

- `seq` - position in this wallet's chain, from 1, no gaps.
- `rk` - the record key wrapped by the DEK (AAD purpose `record`, id = record id).
- `iv`, `ct` - the payload encrypted with the record key; AAD = `aevri.vledger/1|payload|<walletId>|<id>`.
- `ctHash` - SHA-256 of the raw bytes of `ct` (decoded).
- `prevHash` - SHA-256 of the JCS form of the previous envelope's **link** `{id, seq, prevHash, ctHash}`; for
  `seq` 1 it is the hash of the JCS form of `{walletId, createdAt}`.

The kind of record, its time and its content are inside the ciphertext. A provider sees ids, sequence numbers, sizes
and its own upload times only.

The chain gives ordering and lets the holder detect a damaged or edited file. It is **not** a proof towards third
parties; receipts (section 9) are.

### 5.2. Tombstone (erased record)

```json
{ "id": "...", "seq": 17, "prevHash": "sha256:...", "ctHash": "sha256:...", "erased": "2026-10-20T08:00:00Z" }
```

`rk`, `iv` and `ct` are removed. Because the link uses `ctHash`, the chain still verifies. Erasure is final.

### 5.3. Payload (inside the ciphertext)

Every payload has:

| Member | Type | Meaning |
| --- | --- | --- |
| `kind` | string | One of the kinds in 5.4 |
| `createdAt` | time | When the holder created it |
| `supersedes` | id or null | The record this one corrects or revises (the old one stays) |
| `source` | string | `manual`, `import-file`, `counterparty`, `profile`, `vet`, `vss`, `aevri.site`, `aevri.vvp` |
| `body` | object | Kind-specific, section 5.4 and `schema/payload.schema.json` |
| `retainUntil` | date or null | The holder's own wish; a wallet MAY offer erasure after it, never automatically |

### 5.4. Kinds

| Kind | Body (main members) |
| --- | --- |
| `counterparty` | `type` (`self`, `person`, `organization`, `state`, `group`, `unknown`), `name`, `note`, `publicKey?`, `profileUrl?`, `arbiter?` |
| `element-type` | `name`, `category` (`thing`, `service`, `information`, `time`, `money`, `right`, `decision`, `relation`, `other`), `polarityHint?`, `vssRef?` |
| `exchange` | `counterpartyId`, `given[]`, `received[]` (each `{label, typeId?, quantity?, unit?, note?}`), `occurredAt`, `approx?`, `status`, `receipt?` (section 9), `stamps[]`, `rulings[]` |
| `plan` | Planned value declared by the giver: `exchangeId?`, `elementRef`, `authorCounterpartyId`, `promise` (words), `goalCategory?`, `plannedV?`, `profileRef?` |
| `assessment` | `exchangeId?`, `elementRef?`, `phase` (`expected`, `received`, `retro`), `gained[]`, `lost[]`, `ownScore?` ({value, unit}), `contributions[]` ({goalId, c, k?}), `v?`, `planCount?`, `confidence`, `reasons?`, `checkAfter?`, `vet?` |
| `goal` | `title`, `why?`, `signs?`, `horizon?`, `S`, `N?`, `unit?`, `status` (`active`, `reached`, `dropped`), `factIds[]` |
| `fact` | `topic?`, `text`, `certainty` (`low`, `medium`, `high`), `exploring` (bool), `goalIds[]` |
| `settings` | `planCountDefault` (0..1, default 0), `planCountBy[]` ({counterpartyId? , typeId?, factor}), `arbiters[]`, `providers[]` |
| `grant` | `recordIds[]`, `recipient`, `fields[]`, `strip[]`, `until?`, `purpose` |
| `revocation` | `grantId`, `reason?` |
| `disclosure` | `grantId`, `deliveredAt`, `recipient`, `contentHash` |
| `import` | `origin`, `originId`, `payload`, `payloadHash` |
| `note` | `text` |

`elementRef` is `{exchangeId, side: "given" | "received", index}` or `{profileRef, elementId}`.

## 6. Corrections, withdrawal, erasure

- A **correction** is a new record of the same kind with `supersedes` = the old id. Readers show the latest version
  and keep the history.
- A **withdrawal** is a correction whose body is `{ "withdrawn": true }`.
- An **erasure** replaces the envelope with a tombstone (5.2) everywhere the wallet is stored, and deletes the wrapped
  record key. Records that supersede an erased one stay valid.

## 7. Value model

The holder uses any scale. A wallet stores what the holder typed and derives three dimensionless numbers.

- Goal significance `S > 0` and need `N > 0` (default `N = S`), on the holder's scale.
- Contribution of an element to a goal `c` (negative allowed), on the same scale, or typed directly as a share.
- Progress share `k = c / N`.
- Goal weight `w = S / sum(S of active goals)`.
- Comparable value `v = sum over goals (w * k)`.

`v` is "the share of what matters to me now that this moved". It is the only number a wallet shares by default;
`S`, `N`, the goal list and `ownScore` stay private.

**Planned value.** A `plan` from a giver is shown but counts in the holder's own figures only through `planCount`
(0..1). The default is 0 (`settings.planCountDefault`).

**Feeling check.** After the holder enters contributions, the wallet SHOULD say the result in words and ask whether
it fits, for example: "This pen moved about 30% of goal A, which is about half of what matters to you now, so it is
one of your three most valuable things this month. Right?". It SHOULD point out these inconsistencies at entry time,
never later:

1. contributions to an active goal add up to more than `N`;
2. the order of elements by `ownScore` and by `v` differs strongly (Spearman rank correlation below 0.3 over the last
   20 assessed elements);
3. a goal with the largest `S` has no contributions for 90 days while smaller goals have many.

Thresholds are defaults; implementations MAY tune them and MUST NOT turn them into reminders.

## 8. Storage providers

A provider stores encrypted parts of a wallet. The minimal operations (HTTP form in `openapi/provider.yaml`):

| Operation | Meaning |
| --- | --- |
| `putKeyring(walletId, keyring)` | Replace the keyring (if-match revision) |
| `getKeyring(walletId)` | Read it |
| `putRecord(walletId, envelope)` | Store a new envelope; `id` once only |
| `replaceWithTombstone(walletId, id, tombstone)` | Erase |
| `list(walletId, sinceSeq)` | Envelopes after a sequence number |
| `deleteWallet(walletId)` | Remove everything |

Providers MUST NOT require plaintext. A file, a folder, a private Git repository (`vledger/<walletId>/keyring.json`,
`vledger/<walletId>/records/<seq>-<id>.json`), WebDAV, an object store or the institute's server are all providers.
A wallet MAY use several at once; **migration** is: copy keyring and envelopes, verify the chain and every `ctHash`,
then (only after the holder confirms) delete at the old provider.

Sync between devices needs no CRDT: envelopes are immutable, so devices exchange the ids they lack. Two devices may
append at the same `seq`; the device that syncs second rebases its new envelopes after the other's (new `seq` and
`prevHash`; the payload and id are unchanged).

## 9. Exchange receipts (peer-to-peer)

### 9.1. Receipt

```json
{
  "type": "aevri.vledger.receipt", "version": 1,
  "receiptId": "<uuid v7>",
  "occurredAt": "2026-10-17T10:00:00Z",
  "parties": [ { "role": "giver", "key": { "alg": "Ed25519", "x": "..." }, "label": "optional" },
               { "role": "receiver", "key": { "alg": "Ed25519", "x": "..." } } ],
  "elements": [ { "from": 0, "to": 1, "digest": "sha256:...", "type": "service", "label": "optional" } ],
  "plan": [ { "element": 0, "digest": "sha256:..." } ],
  "arbiters": [ { "party": 0, "url": "https://aeilus.institute/arbiter/", "key": {} } ],
  "mandate": { "mode": "attest" }
}
```

- `digest` of an element is SHA-256 of the JCS form of `{salt, label, quantity, unit, note}` with a 16-byte random
  `salt` known to the parties. Labels in clear are optional; digests let a party prove later what was agreed without
  showing it to an arbiter in advance.
- `mandate.mode`: `attest` (default; the arbiter only confirms what was presented and when), `opinion` (the arbiter
  may give an expert opinion when a party asks) or `binding` (the parties give `mandate.arbiter` the power to decide;
  MAY carry `scope` and `rulesUrl`).

### 9.2. Signatures

`receiptDigest` = SHA-256 of the JCS form of the receipt. Each party signs the 32 digest bytes with its identity key:

```json
{ "receipt": { }, "signatures": [ { "party": 0, "alg": "Ed25519", "sig": "<b64u>" } ] }
```

An exchange is **matched** when every party has signed the same `receiptDigest`. Because the mandate is part of the
receipt, a binding mandate exists only when every party signed it; one party cannot bind the other.

Delivery is out of scope (link, QR, file, or a provider or arbiter mailbox carrying ciphertext for the recipient).
Nobody can write into another wallet: an incoming receipt waits in the holder's inbox until the holder accepts or
ignores it. Ignoring leaves no trace with the sender beyond "not matched".

### 9.3. Disputes

If two parties hold receipts with different digests for the same `receiptId`, the exchange is `disputed` in both
wallets as soon as either sees the other's version.

## 10. Arbiters

An arbiter is a service a holder chooses (default for wallets made by ÆVRI tools: the institute). HTTP form in
`openapi/arbiter.yaml`.

- **Stamp.** A party sends `{receiptDigest, signatures}`. The arbiter checks every signature against the keys it is
  given (`parties[].key` sent alongside, no other content) and returns a signed stamp
  `{type: "aevri.vledger.stamp", receiptDigest, parties: [key thumbprints], receivedAt, arbiter: {url, key}, sig}`.
- **Lookup.** A party that proves possession of one of the party keys (signs a fresh challenge) may ask which stamps
  exist for a digest. Nobody else may.
- **Case.** A party opens a case with the receipt (now disclosed), the signatures and its statement. The arbiter
  answers with a signed **ruling** `{type: "aevri.vledger.ruling", caseId, receiptDigest, mode, binding, decision,
  reasons, issuedAt, arbiter, sig}`:
  - mode `attest`: `decision` only states which stamps exist and when; `binding: false`;
  - mode `opinion`: an expert opinion; `binding: false`;
  - mode `binding` and the arbiter is `mandate.arbiter`: a decision; `binding: true`. Wallets of both parties record
    it and set the exchange status the decision names.
- Legal effect outside the wallets depends on the parties' agreement and the applicable law; this format does not
  create it.

**Signed objects.** Receipts are signed over the 32 bytes of `receiptDigest`. Stamps, rulings and named feedback carry
`sig` = signature over the UTF-8 bytes of the JCS form of the object without `sig`. A profile document is
`{profile, sig}` with `sig` over the JCS form of `profile`. A wallet MUST accept a `binding: true` ruling only from the
arbiter whose key is in `mandate.arbiter` of a matched receipt with that digest.

## 11. Organisation and state profiles, feedback

An organisation (or a state body, a municipality) MAY publish a signed **value profile**: who it is, its public key,
its elements with planned value, and where feedback goes. Schema: `schema/profile.schema.json`.

Feedback from a holder is a message `aevri.vledger.feedback` (`schema/feedback.schema.json`): which element, phase,
words, the gap between plan and what was received, and optionally `v`. It is sent only by the holder's action;
`anonymous: true` is the default and the message then carries no wallet key. A profile MUST NOT make feedback a
condition of service, and public aggregates of feedback MUST NOT be shown for fewer than 5 contributions.

## 12. Conformance

A conforming wallet:

1. validates every document against the JSON Schemas in `schema/`;
2. never stores or sends a payload in plain text except a readable export the holder asked for;
3. verifies the chain and every `ctHash` on import and reports breaks without refusing to read;
4. reproduces every fixture in `fixtures/` (open with the given test passphrase, verify signatures and stamps,
   recompute `k`, `w`, `v`).

`tools/verify_fixtures.py` is an independent checker of the fixtures, written without the reference code.
