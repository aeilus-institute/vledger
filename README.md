# Value Wallet (aevri.vledger)

An open, non-commercial standard and a reference app for a personal, encrypted ledger of value:
what passed between you and people, organisations or the state, what was promised, what you received and lost,
and how much it moved your own goals. Russian name: Кошелёк ценности.

- `spec/` - the format and protocols `aevri.vledger` 1.0 (draft), JSON Schemas, OpenAPI, reference modules,
  fixtures and an independent checker. Start with `spec/SPEC.md`.
- `app/` - the wallet app (stage L1, branch `l1-wallet`).
- [`EVENT-STREAMS.md`](EVENT-STREAMS.md) - event streams: how services and devices suggest events to wallets, closed
  streams, feedback with assessments and new events, and how senders are identified (SPEC section 20).

Editor: Aeilus Value Research Institute (ÆVRI), https://aeilus.institute/tools/.
Licence: specification text CC BY 4.0, code and schemas MIT.
