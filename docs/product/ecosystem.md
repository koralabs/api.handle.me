# ADA Handle Ecosystem Notes (External Context)

Last updated: 2026-02-11

This document captures externally published context about ADA Handle ($handle) and the Handle Standard, with an emphasis on product/features that influence this repo (`handles-public-api`).

Some first-party websites (notably `handle.me` and `docs.handle.me`) appear to block automated crawlers in this environment. Where those were inaccessible, this doc leans on:
- Project Catalyst proposal pages (`projectcatalyst.io`)
- ADA Handle Medium posts (`medium.com/ada-handle`)
- Public Kora Labs documents (`public.koralabs.io`)

## Official Sites & Environments (Observed)
- Handle minting/portal: `https://handle.me`
- Public API (this service): `https://api.handle.me` (Swagger UI is also hosted there)
- Marketplace environments referenced in Catalyst: `https://preview.marketplace.handle.me`, `https://preprod.marketplace.handle.me`

## What ADA Handle Is
- A naming system for Cardano addresses where a handle (like `$my.handle`) is minted as a native asset/NFT and owned/transferred like any other asset on Cardano. The “resolved address” is derived from on-chain ownership/UTxO state rather than an off-chain registry.
- Core UX goal: replace intimidating cryptographic wallet addresses with human-friendly identifiers, similar to Venmo/Cash App username mechanics.

Source (intro/overview): `https://medium.com/ada-handle/introducing-ada-handle-a-standard-for-custom-cardano-addresses-5359b42568ce`

## Relevant Standards (CIPs)
Handle asset encoding and newer “reference token + inline datum” styles for NFTs build on Cardano Improvement Proposals (CIPs).

- CIP-67: “Asset Name Label Registry” (includes an example where label `222` yields prefix hex `000de140`)
  - `https://cips.cardano.org/cip/CIP-0067`
- CIP-68: “Datum Metadata Standard”
  - `https://cips.cardano.org/cip/CIP-0068`

## Core Feature Areas That Impact This API

### 1. Handle Resolution (Classic, CIP-68, SubHandles)
Kora Labs provides a resolution cheat sheet that documents how handle names are encoded and how different handle “types” resolve.

Key details from `HandleResolution.pdf`:
- CIP-67 label (222) asset name prefix: `000de140` and then hex-encoded handle name (do not encode `$`).
- CIP-67 label (000) prefix for cases like `john@root` when resolution requires an owner token reference.
- Virtual SubHandles resolve via inline datum containing `resolved_addresses.ada`.
- A `$handle_policies` datum is referenced as the source of “active policies” and associated mint slot ranges.

Sources:
- `https://public.koralabs.io/documentation/HandleResolution.pdf`
- CIP-67 label example: `https://cips.cardano.org/cip/CIP-0067`

### 2. Personalization (Designer + Portal + Pointer Records)
Personalization expands Handles beyond “just a resolver” into cross-platform identity data that wallets/dApps can read.

Published/claimed capabilities and direction:
- On-chain personalization state that can include profile pictures, background images, social links, QR, and other display settings.
- “Pointer record” / smart-contract association model: each Handle references a contract/dataset that platforms can parse.
- IPFS-hosted JSON datasets are described as part of the architecture for flexible updates.
- Future direction includes encrypted datasets (selective disclosure), DID-compatibility, and domain-like behaviors.

Sources:
- Catalyst: `https://projectcatalyst.io/funds/9/dapps-products-and-integrations/handle-personalization-or-ada-handle`
- Medium: `https://medium.com/ada-handle/personalization-101-6708ab692b29`
- Lace wallet blog (Personalized Handles support): `https://www.lace.io/blog/personalized-ada-handle`

### 3. SubHandles (NFT SubHandles + Virtual SubHandles)
SubHandles extend the naming system so a “root handle” owner can mint “child” identifiers (examples used in Catalyst: `treasury@acme`, `john@acme`).

Important product distinctions:
- NFT-based SubHandles: native assets; transferable; lose control when leaving the root owner’s custody.
- Virtual SubHandles: represented as IPFS-hosted JSON datasets and governed by smart contracts so the root owner can revoke/reassign.
- Product motivation includes transparency for organizations (multiple wallets), operational naming (treasury/payroll/etc), and security posture around compromised/leaving-wallet scenarios.

Sources:
- Catalyst: `https://projectcatalyst.io/funds/9/dapps-products-and-integrations/subhandles-or-ada-handle`
- Medium DeMi launch also references resolution behaviors: `https://medium.com/ada-handle/decentralized-minting-mainnet-launch-3a9cd6c7d4f4`

### 4. Decentralized Minting (DeMi)
DeMi is described as a transition from a centralized signer-based minting model to a smart-contract “order and mint” system utilizing Merkle Tree structures.

Notable published concepts:
- Users submit mint “orders” to an orders contract.
- “Batchers” monitor orders and execute minting in batches to manage UTxO contention and protocol constraints.
- A new policy can be introduced for decentralized Handles while preserving resolution semantics.

Sources:
- Catalyst: `https://projectcatalyst.io/funds/10/development-and-infrastructure/decentralized-minting-or-ada-handle`
- Medium: `https://medium.com/ada-handle/decentralized-minting-mainnet-launch-3a9cd6c7d4f4`
- Medium (earlier design): `https://medium.com/ada-handle/decentralized-minting-e3a129c72df4`

### 5. Handle Marketplace (Secondary Market + Personalization Assets + H.A.L. Renderer)
The Handle Marketplace is described as a Handle-centric marketplace focused on discoverability and supporting new standard features without waiting on third-party marketplace integration.

Published scope includes:
- Better filters for text-based assets (length, character classes, community groupings like “10k club”, etc.).
- Marketplace integration for Personalization and SubHandles.
- White-label marketplace concept for root-handle owners.
- CIP-68 (444) minting engine for Personalization assets (backgrounds/accessories/badges/etc.).
- “H.A.L. 3D Personal Avatar Renderer” listed as a milestone deliverable.

Sources:
- Catalyst: `https://projectcatalyst.io/funds/10/products-and-integrations/the-handle-marketplace-or-ada-handle`
- Medium: `https://medium.com/ada-handle/the-handle-marketplace-e6bbc30a6555`

### 6. Wallet Authentication (Anti-bot / Mint Access Control)
A Catalyst-funded effort describes moving the mint portal away from email and toward CIP-30 wallet-based authentication, with optional stake-based requirements to make botting more expensive.

Sources:
- Catalyst: `https://projectcatalyst.io/funds/7/dapps-and-integrations/ada-handle-wallet-authentication`

### 7. HandleChat (Encrypted Messaging + SDK)
HandleChat is described as a decentralized communications protocol using point-to-point encryption, with both off-chain low-latency messaging and optional on-chain “proof” storage for specific messages/documents.

Key concepts:
- Open-source SDK to integrate with wallets/dApps.
- Future “HandleChat Node Operators (HNOs)” to decentralize protocol operation and potentially earn income.
- Optional retention/purging of history (except on-chain proofs).

Current status (as of Catalyst page):
- Fund 11 project is “In progress”, with Preview/PreProd launch marked “Completed” and MainNet launch marked “In Progress” with a stated delivery month of Jan 2026.

Source:
- Catalyst: `https://projectcatalyst.io/funds/11/cardano-use-cases-product/handlechat-by-ada-handle-or-dollarhandle`

### 8. HandlePay Framework (Venmo-like Payments App) (Not Approved)
HandlePay is described as a proposed “framework” for a Venmo/CashApp/Splitwise-like mobile app with built-in chat. It references integrating HandleChat and an existing $handle OAuth.

Status on Catalyst page: “Not approved”.

Source:
- Catalyst: `https://projectcatalyst.io/funds/13/cardano-use-cases-product/handlepay-framework-by-dollarhandle`

## Integrations and Partners (Public Mentions)

### Wallets
Examples of wallets that publicly mention ADA Handle support:
- Yoroi (send to ADA Handles): `https://emurgohelpdesk.zendesk.com/hc/en-us/articles/6743018894991-How-to-use-ADA-Handle-on-Yoroi`
- Eternl (Chrome store listing mentions Ada Handles in Address Book): `https://chromewebstore.google.com/detail/eternl/kmhcihpebfmpgmihbkipmjlmmioameka`
- Typhon (Chrome store listing mentions Ada Handle support): `https://chromewebstore.google.com/detail/typhon-wallet/kfdniefadaanbjodldohaedphafoffoh`
- Lace (blog: Personalized ADA Handles support): `https://www.lace.io/blog/personalized-ada-handle`
- NuFi (blog: partnership and handle-resolution support): `https://nu.fi/blog/the-ada-handle-partnership-with-nufi-is-live`

### dApps / protocols / services (partnership posts)
ADA Handle has published multiple partnership announcements indicating address-resolution or UX integrations into other Cardano dApps/services. This list is non-exhaustive.
- SundaeSwap: `https://medium.com/ada-handle/ada-handle-partners-with-sundaeswap-b4697e8b3f9e`
- MuesliSwap: `https://medium.com/ada-handle/ada-handle-partners-with-muesliswap-ae3cc5a82b5f`
- Indigo Protocol: `https://medium.com/ada-handle/ada-handle-partners-with-indigo-protocol-3202a0c75b76`
- MELD: `https://medium.com/ada-handle/ada-handle-partners-with-meld-833bf7cabae7`
- World Mobile: `https://medium.com/ada-handle/ada-handle-partners-with-world-mobile-7024cb5a5714`
- Liqwid Finance: `https://medium.com/ada-handle/ada-handle-partners-with-liqwid-finance-d4d81b7b7d56`
- Iagon: `https://medium.com/ada-handle/ada-handle-partners-with-iagon-3eacd8b23bfc`
- Revuto: `https://medium.com/ada-handle/ada-handle-partners-with-revuto-5c41ab21e114`
- Cardashift: `https://medium.com/ada-handle/ada-handle-partners-with-cardashift-854e63dbea84`
- CardMix: `https://medium.com/ada-handle/ada-handle-partners-with-cardmix-cce4e93ac530`
- Fluid Tokens: `https://medium.com/ada-handle/ada-handle-partners-with-fluid-tokens-52712884ba7f`

### Explorers
Examples:
- Cardanoscan: `https://medium.com/ada-handle/ada-handle-partners-with-cardanoscan-4a513ea6d81a`
- Cexplorer: `https://medium.com/ada-handle/ada-handle-partners-with-cexplorer-cf5ddf06cbb5`

### Wallet integrations and campaigns (Catalyst mentions)
Catalyst proposal text references marketing coordination and integrations with major wallets during feature launches (examples called out in Fund10 proposal text include Eternl and Lace).

Source:
- `https://projectcatalyst.io/funds/10/products-and-integrations/the-handle-marketplace-or-ada-handle`

### Community tooling
`handle.tools` presents itself as a community tool for checking availability/listings/sales and notes it searches multiple marketplaces (e.g., JPG.store, Plutus.art, CNFT.io, CardaHub, Epoch.art).

Source:
- `https://handle.tools/`

## Catalyst Proposals & Milestones (High-level)
Milestones below are summarized from the public Catalyst pages (delivery months are the proposal’s stated months).

- Fund 7: Wallet Authentication (Complete): `https://projectcatalyst.io/funds/7/dapps-and-integrations/ada-handle-wallet-authentication`
  - Note: older fund pages in this environment showed monthly reports rather than a milestone table.

- Fund 9: Personalization (Complete): `https://projectcatalyst.io/funds/9/dapps-products-and-integrations/handle-personalization-or-ada-handle`
  - 1/5: Architecture and Planning (Jul 2022)
  - 2/5: Smart Contract Development (Sep 2022)
  - 3/5: API Development (Oct 2022)
  - 4/5: Portal Development (Nov 2022)
  - 5/5: Community Launch and Further Refinement (Dec 2022)

- Fund 9: SubHandles (Complete): `https://projectcatalyst.io/funds/9/dapps-products-and-integrations/subhandles-or-ada-handle`
  - 1/6: Architecture and Planning (Jul 2022)
  - 2/6: Smart Contract Development (Aug 2022)
  - 3/6: CIP-67/68 Development and Standardisation (Sep 2022)
  - 4/6: Portal Development (Nov 2022)
  - 5/6: Community Launch (Dec 2022)
  - 6/6: CPO and Milkomeda Integration (Jan 2023)

- Fund 10: Decentralized Minting (Complete): `https://projectcatalyst.io/funds/10/development-and-infrastructure/decentralized-minting-or-ada-handle`
  - 1/5: Planning and Architecture (Jan 2023)
  - 2/5: DeMi Smart Contract Development and Testing (Mar 2023)
  - 3/5: Handle Minting Portal (Apr 2023)
  - 4/5: Platform-Wide Implementation and Adoption Strategy (May 2023)
  - 5/5: Community Launch and Support (Jun 2023)

- Fund 10: Handle Marketplace (Complete): `https://projectcatalyst.io/funds/10/products-and-integrations/the-handle-marketplace-or-ada-handle`
  - 1/6: Marketplace UX Design and Planning (Jan 2023)
  - 2/6: Marketplace Development (Mar 2023)
  - 3/6: Community Launch and Further Refinement (Apr 2023)
  - 4/6: H.A.L. 3D Personal Avatar Renderer (May 2023)
  - 5/6: Handle Background Creator and Custom Background Minter (Jun 2023)
  - 6/6: Handle Background Creator Launch and Promotion (Jul 2023)

- Fund 11: HandleChat (In progress): `https://projectcatalyst.io/funds/11/cardano-use-cases-product/handlechat-by-ada-handle-or-dollarhandle`
  - 1/6: Product design and planning (Aug 2024)
  - 2/6: Smart contract architecture and development (Oct 2024)
  - 3/6: HandleChat protocol development and testing (Jun 2025)
  - 4/6: Preview/PreProd launch and further refinement (Aug 2025)
  - 5/6: MainNet Launch and Support (Jan 2026)
  - 6/6: Technical white paper and protocol improvements (Feb 2026)

- Fund 13: HandlePay Framework (Not approved): `https://projectcatalyst.io/funds/13/cardano-use-cases-product/handlepay-framework-by-dollarhandle`
  - Still contains useful public references such as marketplace environments and notes about an alpha $handle OAuth.

## Ecosystem Pain Points (From Published Context)
Themes repeated across proposals/posts that matter for this API:
- Resolution complexity (CIP variants, owner tokens, policy transitions) is non-trivial for integrators; the API is positioned as an abstraction layer.
- Adoption lag: new features (Personalization, SubHandles, Marketplace behaviors) require many partner wallets/dApps/marketplaces to update to new standard behaviors.
- High-volume minting and bot pressure: mint portals need wallet auth/rate limiting; scanning/indexing needs to tolerate surges while remaining correct.
- UTxO contention in decentralized minting: “batching” and careful ordering are required (and affects how quickly a public API can be “caught up”).
- Privacy: Handles are intentionally not a privacy solution; personalization increases identity data surface area; proposals discuss encrypted/selective sharing as a future direction.

## How This Public API Fits
This repo is primarily an indexing + query system that:
- Abstracts resolution lookups into stable HTTP endpoints.
- Exposes handle catalog search/filtering and holder lookups for wallets/dApps/marketplaces.
- Exposes personalization and subhandle settings/UTxO views required for correct rendering and protocol integration.
- Exposes health/sync status so integrators can reason about freshness (`200` vs `202`).

See:
- Swagger: `docs/swagger.yml`
- Spec: `docs/spec/spec.md`
