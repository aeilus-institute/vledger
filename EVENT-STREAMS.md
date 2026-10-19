# Event streams for the Value Wallet

An open protocol for services and devices that know what happened to people and want to offer it to them: a second
brain that transcribes meetings, a calendar, a smart home, an employer's task tracker, a city's road works, a
newsroom. The stream suggests events; each person decides what enters their own Value Wallet. People can also send
assessments and their own events back to the stream, and anyone can run a stream of their own.

This page is the overview. The normative text is section 20 of [`spec/SPEC.md`](spec/SPEC.md) (draft 1.0-d10), the
schemas are in [`spec/schema/stream.schema.json`](spec/schema/stream.schema.json) and
[`spec/schema/message.schema.json`](spec/schema/message.schema.json). Human-readable page:
https://aeilus.institute/tools/vledger/streams/. Status: draft, reviewed with Codex and Grok; wallet support is in
development, the first provider is 2dBrain.

## The rules in one minute

1. **A stream only suggests.** Events arrive as suggestions. Nothing reaches a person's timeline until they confirm
   it (one by one, or by a rule they made themselves).
2. **Nothing goes back by itself.** The provider never reads the wallet and learns nothing about confirmations,
   rejections or ratings. People send feedback only by their own action, each time.
3. **A new key for every stream.** The wallet makes a key for each stream on each device, so two providers cannot
   recognise the same person by key. The main wallet address is never needed.
4. **Words, not recordings.** Events carry who did what with what or whom. Audio, video and transcripts stay with the
   provider.
5. **No profiling, no scores of people.** Providers must not link subscriptions, build profiles or turn assessments
   into rankings of people.

## Three ways to open a stream

| `access` | Who can connect | How | Example |
| --- | --- | --- | --- |
| `open` | anyone | a QR code or a link | a city's road works, a conference programme, institute publications |
| `code` | whoever sees a one-time code | the provider shows a QR code on a screen only its owner sees; both sides show the same 8 characters before approval | your own second brain at home or inside a VPN |
| `attested` | people with an attestation the stream trusts | a QR code or a link, then one tap "Confirm with ÆVRI" or "Confirm with my employer" | a department's stream, residents of a town |

The connect link keeps everything after `#`, so nothing reaches a web server:

```
https://aeilus.institute/tools/vledger/#stream=<descriptor URL>&code=<pairing code>
https://aeilus.institute/tools/vledger/#stream=vw1:<provider address>&code=<pairing code>&relay=<relay URL>
```

A provider describes itself in a signed **descriptor**: who it is, its key, what it suggests, how it delivers
(`https` pull or end-to-end encrypted `relay` push, so a machine at home needs no open port), what it keeps and for
how long, and what feedback it accepts.

## An event

```json
{ "type": "aevri.vledger.stream-event", "version": 1,
  "streamId": "...", "eventId": "call-2026-10-19-0930", "rev": 1, "recipient": "vw1:<subscription key>",
  "occurredAt": "2026-10-19T09:30:00Z", "kind": "meeting",
  "actor": { "ref": "p1", "label": "Anna" }, "action": "agreed the pilot plan",
  "objects": [ { "label": "pilot plan for Q4", "type": "decision" } ],
  "participants": [ { "ref": "p2", "label": "Victor", "role": "affected", "you": true } ],
  "summary": "At most 1000 characters", "sig": "<provider signature>" }
```

A private stream may mark which participant is the subscriber (`you`). In an open stream the wallet asks once
"Which of these is you?" and remembers it on the device; the provider is never told. Corrections come with a higher
`rev` and never overwrite what the person already confirmed.

## Sending back: assessments and your own events

A stream may accept three kinds of **feedback**: an assessment of one of its events, "I took part in this", or a new
event it does not know ("I used the new road"). The stream says in its descriptor what it accepts, whether the owner
moderates (`none`, `before`, `after`) and whether feedback is published. The wallet shows this before anything is
sent, sends only what the person picked (a one-tap reaction, words, what it gave and what it cost; never goals or
the personal scale), and keeps the signed receipt. The sender can withdraw an item at any time.

### How a sender is identified

The person chooses, among the levels the stream accepts:

| Level | What the stream learns | How |
| --- | --- | --- |
| **anyone** | nothing about the sender | the item is signed by a key made for it alone |
| **checked, not named** | "a checked account at ÆVRI", "a member of the unit", "a resident" | the same one-time key, plus an **attestation** about that key from an issuer the stream trusts |
| **named** | the sender's wallet address and the name on their card | signed by the wallet's own key, with the card |

An **attestation** is a short statement signed by an issuer about one key: `account-verified` from the institute
(signed in on aeilus.institute with a confirmed e-mail), `member:<unit>` from an employer, `resident:<place>` from a
town. Getting one is one tap in the wallet. It is scoped to one stream and lives at most 30 days in the pilot. It is
pseudonymity towards the stream, not anonymity towards the issuer: the issuer knows which of its accounts the key
belongs to, but never sees what is sent with it, and must not hand over that link. The same attestations can close a
stream (`access: "attested"`), so a department stream needs no codes: members open the link and confirm with their
employer.

```json
"access": "attested",
"requires": { "issuer": "vw1:<employer key>", "claim": "member:datsteam-dit" },
"feedback": { "accepts": ["assessment", "participation", "event"],
              "senders": ["anonymous", "subscriber", "named"],
              "moderation": "before", "publishes": "sender-choice",
              "requires": { "issuer": "vw1:<ÆVRI key>", "claim": "account-verified" } }
```

## Your own stream

Anyone can publish their own assessments of events, or share events and assessments with chosen people who connect
by QR code. The wallet signs everything with a key made for that stream; a host (the institute, optionally) keeps
the signed items and serves them, but cannot change them unnoticed, add readers or read private items.

## Building a provider: checklist

- [ ] A key pair (Ed25519 to sign, P-256 to receive) and a signed descriptor at a stable HTTPS URL, or a card at the
      relay for relay-only providers.
- [ ] Pairing codes with at least 128 random bits, valid 10 minutes, single use; show the 8-character fingerprint.
- [ ] Events signed, at most 100 per response, encrypted to the subscription key for private streams.
- [ ] Only events the subscriber took part in (private streams); keep events so the wallet can ask for a replay.
- [ ] Leave: stop sending, delete what the policy promises, answer with a signed receipt.
- [ ] Feedback (optional): state moderation and publication, send signed receipts, honour withdrawals, never make
      feedback a condition of anything.
- [ ] Attestations (optional): name one issuer and one claim per requirement; check signature, subject, audience and
      expiry on every request.

Questions and proposals: open an issue in this repository.

Licence: this text CC BY 4.0, schemas and code MIT.
