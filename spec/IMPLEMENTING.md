# Implementing your own value wallet

You can build a wallet, a storage provider or an arbiter in any language. This page is the short path; the rules are
in `SPEC.md`.

## 1. Read and write the format

1. Validate documents with the JSON Schemas in `schema/` (draft 2020-12; `$id` base
   `https://aeilus.institute/schema/vledger/1/`).
2. Implement JCS (RFC 8785). Numbers must be serialised like ECMAScript `Number.prototype.toString`; see
   `num()` in `tools/verify_fixtures.py` for a 40-line version.
3. Implement the key path: passphrase -> PBKDF2-SHA-256 -> KEK -> AES-GCM open the slot -> DEK -> open the record key
   -> open the payload. The AAD string is `aevri.vledger/1|<purpose>|<walletId>|<id>`; it is the most common bug.
4. Verify the chain: `prevHash` of record n = SHA-256 of JCS `{id, seq, prevHash, ctHash}` of record n-1; for record 1,
   of `{walletId, createdAt}`.

## 2. Prove it with the fixtures

`fixtures/manifest.json` lists every fixture with the schema it must pass and what to expect.
`fixtures/wallet-a.plain.json` holds the test passphrase, the test provider recovery key and the plain payloads.
Your implementation conforms when it:

- opens `wallet-a.vledger.json` and `wallet-b.vledger.json` with their passphrases and gets the same payloads;
- verifies the four cards and the municipality registry, and rejects the tampered card;
- decrypts each message with the recipient wallet's exchange key, verifies the sender, and fails with any other wallet;
- applies wallet A's request blocking: the City request is dropped, the toothpaste maker's request is not;
- recomputes the analytics of wallet A (four confirmed events, the suggested one left out);
- finds exactly one problem in `invalid-wallet-tampered.vledger.json`;
- reports `matched` for `receipt-matched.json` and `receipt-binding.json`, and not for the one-signature and tampered
  receipts;
- verifies the arbiter stamp and rulings;
- rejects the three `invalid-*` documents that are invalid by schema;
- recomputes every `v`, `spentV` and efficiency, nearest references, the retro rule, plan factors, request blocking and
  address parsing in `value-cases.json`.

Run the independent checker to see the expected output:

```bash
python tools/verify_fixtures.py
```

It needs the `jsonschema` and `cryptography` packages.

## 3. Regenerate fixtures

`reference/make-fixtures.html` produces a fresh set with the browser's Web Crypto. Serve the package with
`python tools/devserver.py 8790` (it binds to 127.0.0.1 and accepts writes only to `fixtures/*.json`), open
`http://127.0.0.1:8790/reference/make-fixtures.html`, press the button, then run the checker. Ids, keys and
ciphertexts change every run; the expectations do not.

## 4. Be a provider

Implement `openapi/provider.yaml` or map it onto storage you already have (a Git repository: one file for the keyring,
one file per envelope; WebDAV; an object store). Never ask for keys or plain text. Erasure means deleting the
ciphertext and the wrapped key, not hiding them. If you offer recovery, publish your key and procedure at
`GET /recovery` and keep the private key away from the storage host.

## 5. Be an arbiter

Implement `openapi/arbiter.yaml` (and, for a relay, `openapi/relay.yaml`). Keep digests, key thumbprints and times. Check every signature before you stamp.
Decide only when a matched receipt names your key in a `binding` mandate; otherwise attest or give an opinion and set
`binding: false`.

## 6. What you must not do

- Store or send payloads in plain text, except a readable export the holder asked for.
- Write into someone else's wallet: incoming receipts wait in the holder's inbox.
- Compute or show a score of a person, or add up values of different people.
- Remind or nudge the holder to assess something after the single optional prompt.
