# Value Wallet app - stage L1 (local wallet)

Branch `l1-wallet`. Requirements: `docs/VLEDGER/AEILUS_VLedger_TZ_v0.2.md` in the portfolio (stage L1, AT-1...AT-7).
Format: `../spec/SPEC.md` (`aevri.vledger` 1.0-d1).

## What it is

A standalone installable web app (PWA): plain ES modules, no build step, no external scripts or fonts, works offline.
The wallet is stored on the device (IndexedDB), always encrypted with the holder's passphrase. Nothing is sent
anywhere; there is no account and no server part in L1.

| File | Role |
| --- | --- |
| `index.html`, `assets/boot.js` | Shell with a strict CSP, service worker registration on https |
| `assets/vledger-crypto.js`, `assets/vledger-value.js` | The L0 reference modules, byte-identical to `../spec/reference/` (checked by the self-test) |
| `assets/vledger-store.js` | Wallet model: create, unlock, add, correct (supersede), withdraw, erase (tombstones), lineage, settings, export (encrypted / readable), merge of copies, passphrase change, IndexedDB provider |
| `assets/vledger-ui.js`, `assets/vledger.css` | UI: start (create / open / import), tabs Exchanges, Counterparties, Goals, Facts, Settings; forms; feeling check; idle lock after 15 minutes |
| `assets/locales/en.json`, `ru.json` | English and Russian, written by hand |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Offline cache of the app files only, install metadata |
| `tests/selftest.html` | 24 automatic checks: AT-1...AT-7, merge, passphrase change, IndexedDB, conformance with the L0 fixtures |

## What the holder can do in L1

- Create a wallet (passphrase of at least 4 words or 14 characters, explicit "nobody can recover it"), open it,
  lock it; several wallets per device.
- Counterparties: people, organisations, state and municipalities, groups.
- Exchanges: what I received and gave (lines with amount, unit, type), when, approximately.
- What was promised (planned value of the giver); counted 0 by default, a default factor and per-counterparty factors
  in Settings, and a per-assessment slider.
- How it was for me: phase expected / received / later, lines "got" and "lost", my own score on any scale,
  contributions to goals in goal units or as a share; the comparable value in words while typing; "compare again
  after" date shown only when the wallet is opened.
- Feeling check after saving: the result in words, "about right / less / more", and flags (overfilled goal, own scores
  disagree with the shares, the top goal untouched for 90 days).
- Goals with importance, need and unit; weight now and progress. Facts with certainty and "still exploring",
  revised by new versions.
- Every item: correct (history kept), withdraw, erase for good (tombstones keep the integrity chain).
- Export encrypted file, export readable file (with a warning), open a file on another device, merge two copies of the
  same wallet, check integrity, change passphrase, remove from the device.

## Run locally

```bash
python ../spec/tools/devserver.py 8791 ..
```

Then open `http://127.0.0.1:8791/app/` and `http://127.0.0.1:8791/app/tests/selftest.html`.

## Verified (2026-10-17, Chromium in the Claude desktop app)

- Self-test: all 24 checks pass, including "no network requests during wallet work" and opening the L0 fixture
  wallet with the same 21 records as the Python checker.
- Manual run: created a wallet, two goals (1 000 000 / 200 000 points and 1 000 000), an exchange with a new
  counterparty, an assessment with a 60 000 contribution: the app said "about 30% of the goal, which is about 50% of what
  matters, so about 15%"; "less" reopened the form, 30 000 gave 7.5%; a promise showed "counted 0%"; IndexedDB held no
  plain text; lock, wrong passphrase refused, right one reopened; Russian UI; 375 px wide without horizontal scroll.

## Not in L1 (next stages)

- Backup providers (ÆVRI, GitHub), provider recovery slot in the UI, 18+ for providers - L2.
- Receipts with counterparties, arbiter, organisation profiles and feedback - L3.
- VET and VSS bridges - L4. Native apps - L5.
- Other site languages (through the owner's relay), the Bitrix page `/tools/vledger/` and the Tools card update -
  at merge and deploy, with the owner's yes.
