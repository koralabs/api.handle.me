# api.handle.me canonical contract

Indexes Handle state read from the chain and serves it over HTTP. It observes chain state only; it never mints, signs or changes settings.

1. The response is for the requested handle: name or explicit hex lookup (hex must match the stored asset hex), returning the stored resolved ADA address, datum and UTxO identity. Missing, invalid and restricted names keep their distinct errors; an address is never fabricated.
2. State is projected from chain facts: spent inputs are removed, burns handled, and transfers and burns update or remove holder and reverse indexes. Older updates never replace newer recipient/properties (earlier mint evidence may still correct creation history), and personalization is preserved when the ownership UTxO moves.
3. Provider conversion (Koios, Demeter) preserves transaction/output identity, datum, scripts and slot, and commits only complete blocks in stream order.
4. Readers are told about partial state: 503 while REINDEX rebuilds indexes, 202 for rollback/lag, 200 only when caught up (slot tolerance 300 mainnet / 600 testnet; uninitialized metrics are never caught up).
5. A snapshot is admitted only with verified chain-root and network evidence, and destructive recovery requires holding the scanner lease; on refusal or lost ownership the existing cache survives. Store keys are network-scoped.
6. Possible double-mint evidence is logged and counted, never silently discarded; the API does not itself prevent duplicate issuance.
