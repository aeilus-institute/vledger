# Value Wallet app - stage L1 (local wallet), format aevri.vledger 1.0-d2

Branch `l1-wallet`. Requirements: `docs/VLEDGER/AEILUS_VLedger_TZ_v0.3.md` in the portfolio (with v0.2 for what v0.3
does not replace). Format: `../spec/SPEC.md` (1.0-d2).

## What it is

A standalone installable web app (PWA): plain ES modules, no build step, no external scripts or fonts, works offline.
The wallet lives on the device (IndexedDB), always encrypted with the holder's passphrase. Nothing leaves the device
unless the holder exports a file or prepares a message.

| File | Role |
| --- | --- |
| `index.html`, `assets/boot.js` | Shell with a strict CSP, service worker on https |
| `assets/vledger-crypto.js`, `assets/vledger-value.js` | The spec reference modules, byte-identical to `../spec/reference/` (checked by the self-test) |
| `assets/vledger-store.js` | Wallet model: create, unlock, records with corrections and erasure, settings, export / merge, passphrase change, cards, messages (share, receive with request blocking), device suggestions |
| `assets/vledger-qr.js` | Own QR encoder (byte mode, level M, versions 1-10), cross-checked against `segno` |
| `assets/vledger-ui.js`, `assets/vledger.css` | UI: Timeline, Contacts, Systems and goals (with facts), Analytics, Inbox, Settings |
| `assets/locales/en.json`, `ru.json` | English and Russian, by hand |
| `tests/selftest.html` | 27 automatic checks: TZ v0.3 AT-1...AT-13, QR against segno, spec fixtures |
| `tests/make_qr_vectors.py` | Writes `qr-vectors.json` with `segno` (independent QR library) |

## What the holder can do

- **Timeline of events** "who did what with what or whom": I did something; someone did something to me or for me;
  I use something someone made; I saw it. Filters by value system, role and contact; events grouped by day.
- **From a registry**: open a signed registry file of an organisation or a municipality, check its signature, pick an
  object ("I use this") or an event ("this affected me"); the owner becomes a contact with its card, the registry's
  value system is added (weight 1, adjustable), the promise comes as a plan.
- **Plan, realized, looking back**: the supplier's promise or one's own expectation; it counts 0 by default; the
  "looking back" phase opens only after a realized assessment.
- **Assessment with orientation**: references of the same value system (own assessments marked as references and the
  registry's public ones) and the system's goals with their global weights and progress; words for gained and lost;
  contributions to goals; what it cost (spent value) and efficiency; own score on any scale; the feeling check with
  the ratio to the nearest reference ("about twice the reference ...").
- **Value systems and goals**: systems with weights in one's life; goals inside them; the global goal weight and the
  progress bar; facts that can be revised.
- **Contacts**: my address as text, link and QR code; my card file for encrypted messages; add a contact by name, by
  pasted address or link, by a card file, or by scanning a QR code where the browser can read barcodes; per-contact
  request blocking.
- **Sharing**: a share message encrypted for the event's other side (or the registry owner), with their storage policy
  shown first, publication choice and an option to send without one's address; delivered as a file in L1.
- **Inbox**: messages from files (shares, assessment requests, cards, device suggestions); blocked requests are dropped
  silently; suggested events wait for confirm / correct / reject.
- **Analytics** on the device: events, assessed, value, spent, efficiency by value system (with weight against share of
  value), contact, action and role, for 30, 90, 365 days or all time.
- **Settings**: request blocking (all, by system, by contact), promised value counting, my storage policy for my card,
  types of things, export (encrypted / readable), open or merge a file, integrity check, passphrase change, removal.

## Run locally

```bash
python ../spec/tools/devserver.py 8791 ..
```

Then open `http://127.0.0.1:8791/app/` and `http://127.0.0.1:8791/app/tests/selftest.html`.

## Verified (2026-10-17, Chromium in the Claude desktop app)

- Self-test: all 27 checks pass. They include AT-4 (systems 3 and 1, v 22.5%, spent 5%, efficiency 4.5), AT-9 (the
  recipient decrypts and verifies; nobody else can), AT-10 (a City request dropped, a Family one kept), AT-11
  (suggestions stay out of the timeline), AT-13 (no network requests), 16 QR symbols equal to segno, and the spec
  fixtures (wallet A and B, share and request messages).
- Manual run in Russian: two systems and goals; a registry object from the municipality fixture (signature checked,
  owner contact with card, system and plan added, "counted 0%"); "Daughter hugged me" assessed and marked as a
  reference; a second family event said "about twice the reference"; the road with a cost showed efficiency 4 and
  the public reference; the share dialog showed the municipality's storage policy; QR and address on Contacts;
  analytics by system, contact, action and role; 375 px wide without horizontal scroll.
- Found and fixed during the run: the feeling check compared an assessment with itself when it was just marked as a
  reference; registry objects did not count for their owner in contacts and analytics.

## QR note

`segno` 1.6 writes 8 extra zero bits after the terminator when the bit stream is already byte-aligned
(`encoder.py`, `write_padding_bits`), which ISO/IEC 18004 7.4.10 does not ask for. Both forms decode. The app follows
the standard; the cross-check test turns on `segnoQuirk` to compare module by module.

## Not in L1

Backup providers and recovery (L2); the institute relay, receipts with arbiters in the UI, public registries online
(L3); VET and VSS (L4); native apps and the device / agent API (L5).
