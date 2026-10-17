# Architecture decisions for aevri.vledger 1.0 (L0, 2026-10-17)

Each decision: context, decision, consequences. Owner decisions are cited as D-n (`../AEILUS_VLedger_TZ_v0.2.md` 0.1).

## ADR-001 Cryptography: Web Crypto only, PBKDF2 now, Argon2id later

**Context.** Encryption is mandatory everywhere (D-1, D-2). The first client is a plain ES-module web app without a
build step and without external libraries (ADR-001 of VET, charter PC-3.4). Web Crypto has AES-GCM, PBKDF2, HKDF,
ECDH P-256 and Ed25519 in current Chrome, Firefox and Safari; it has no Argon2.

**Decision.** AES-256-GCM everywhere with an AAD that binds every ciphertext to its wallet, purpose and id;
PBKDF2-HMAC-SHA-256 with at least 600 000 iterations for passphrases; Ed25519 signatures (ES256 allowed as a fallback
in the format); ECDH P-256 + HKDF for the provider recovery slot. `argon2id` is already a valid `kdf` in the schema
so native clients (L5) or a later WASM build can use it without a format change.

**Consequences.** No third-party code in the trust path. PBKDF2 is weaker than Argon2id against GPU guessing, so the
client asks for a passphrase of at least 4 words or 14 characters. Opening a wallet takes about half a second.

## ADR-002 Provider recovery: the provider's key alone, after a procedure

**Context.** Self-custody means a lost passphrase loses the wallet. A provider may offer recovery; the owner chose
recovery by the provider's key (D-9) over a 2-of-2 scheme.

**Decision.** Slot kind `provider-recovery` wraps the DEK to the provider's ECDH public key (ephemeral-static,
HKDF, AES-GCM). The provider publishes its key, its procedure (identity check, delay, notifications) and minimum age
at `GET /recovery`. The wallet states plainly before enabling it that the provider can technically read the wallet.
Slot kind `recovery-code` stays in the format for a 2-of-2 offer (COULD).

**Consequences.** The provider's recovery private key is the most sensitive secret of the service: offline or HSM,
never on the web host. The procedure is a promise, not a cryptographic guarantee; the holder chooses the provider.

## ADR-003 Record chain: links over ciphertext hashes, real erasure

**Context.** Records must be immutable in meaning, erasable in fact (TZ INV-6) and give the holder tamper evidence.

**Decision.** Each envelope links to the previous one by the hash of `{id, seq, prevHash, ctHash}`. `ctHash` is over
the ciphertext, so erasing a record (removing `rk`, `iv`, `ct`) keeps the chain valid. The record kind and time are
inside the ciphertext.

**Consequences.** The chain proves nothing to third parties and is not presented as proof; receipts do that. A
provider learns the number and size of records and nothing else.

## ADR-004 Sync without CRDT libraries

**Context.** Grok suggested Automerge, Yjs or Evolu. Records are immutable, so the record set only grows.

**Decision.** Devices exchange missing ids; a device that appended at a taken `seq` rebases its own new envelopes
(new `seq` and `prevHash`, same id and payload). Corrections are new records, so there are no content conflicts.

**Consequences.** No external sync library. The rare true conflict ("two devices corrected the same record") shows
two versions side by side and the holder picks one with a new correction.

## ADR-005 Peer receipts and arbiters instead of a common register

**Context.** D-4: no blockchain, no common list; peers must agree; an arbiter chosen by the holder, the institute by
default. D-10: the arbiter decides only with the power both parties gave it.

**Decision.** A receipt is signed by every party over its JCS digest; "matched" means every party signed the same
digest. Element contents are salted digests, so an arbiter can stamp without seeing them. The mandate (`attest`,
`opinion`, `binding`) is inside the signed receipt, so a binding mandate exists only if every party signed it.
Stamps and rulings are signed by the arbiter key.

**Consequences.** The institute as default arbiter stores digests, thumbprints and times only; content reaches it only
in a case a party opens. Legal force of a binding ruling outside the wallets needs the parties' agreement and the
arbiter's rules (input for the institute's legal setup, D-15).

## ADR-006 Comparable value v = sum(w * k)

**Context.** Everyone has their own scale (D-3); what can be compared is the significance of a goal in a life and
the contribution of an element to it. The owner accepted this formula as a start (D-11).

**Decision.** `k = c / N`, `w = S / sum(S of active goals)`, `v = sum(w * k)`. Only `v` (and optionally the goal
category and words) leaves the wallet. Feeling checks (overfilled goal, rank disagreement between the holder's own
scores and `v`, untouched top goal) run at entry time only.

**Consequences.** `v` changes when goals change: an old assessment keeps the `v` stored at the time, and the wallet may
show the current recomputation next to it. The formula is versioned with the format; a richer model is a 1.x
extension, not a silent change.

## ADR-007 Where L0 lives

**Context.** The site working copy (`current/aeilus.institute/docroot/tools/vet`, `vss`) is being changed by another
session (team mode, GitHub packages).

**Decision.** L0 is a standalone package in `docs/VLEDGER/L0/` (spec, schemas, OpenAPI, reference modules, fixtures,
tools). In L1 the reference modules move into `docroot/tools/vledger/assets/` and the package becomes the source of the
open standard repository (L5).

**Consequences.** No changes to the site code in L0; nothing deployed.

## ADR-008 Events instead of exchanges (d2, 2026-10-17)

**Context.** The owner (TZ v0.3 D-16, D-17) described the wallet as a timeline of "someone did something with
something or someone", where the holder may be the actor, the affected one, or a user of someone else's object, and
where events may come from a registry (a municipality built a road).

**Decision.** One record kind `event` with `actor`, `action`, `objects`, `affected` and the holder's `role`. An exchange
is just an event with objects passing between two contacts. Plans are separate records authored by the supplier (or by
self for one's own expectation); assessments are `realized` or `retro`, and retro needs an earlier realized one.

**Consequences.** d1 wallets are not migrated: no wallet had been published.

## ADR-009 Value systems and global goal weight (d2)

**Context.** D-19: when assessing, show references of the same value system and the system's goals with their global
value in the holder's whole value system. D-24: spent value and efficiency.

**Decision.** `value-system` records with weight `W`; global goal weight `w = ω * σ`; `v` and `spentV` with the same
formula; `e = v / spentV`. Goals without a system go to "Other" (mean `W`); goals of a dropped system weigh 0.
Own assessments can be marked `reference`; registries carry public references.

## ADR-010 Addresses, cards, messages, relays (d2)

**Context.** D-18 and D-20: every wallet has an address and a QR code; assessments travel P2P through the institute,
which passes but does not keep them; those who keep them must say so.

**Decision.** Address `vw1:` + Ed25519 key; a signed card adds an ECDH P-256 exchange key and a storage policy.
Messages are ECIES-encrypted to the card's exchange key and signed by the sender (or anonymous). The relay protocol
holds a message only until pickup (at most 14 days) and logs no content. Request blocking is applied by the receiving
wallet, so senders cannot tell blocked from ignored.

**Consequences.** To send an encrypted message you need the recipient's card, not only the address; a QR can carry
the address alone (contact) or point to the card (later, through the relay or a registry).

## ADR-011 Suggested events (d2)

**Decision.** Devices and agents deliver `suggestion` messages; events are stored with `status: suggested` and stay
out of the timeline and analytics until the holder confirms. Raw recordings never enter the wallet.
