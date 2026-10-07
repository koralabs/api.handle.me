# DeMi minting API — planned design

Status: agreed direction, not implemented. No new endpoints are defined in OpenAPI yet.
Product requirements: [PRD](../product/prd.md#planned-demi-minting-api).

## Boundary

api.handle.me becomes the public minting interface for both handle.me and third-party integrations. It builds unsigned **DeMi order transactions**, not the final mint transaction. The wallet signs and submits; the existing engine verifies orders, mints, delivers, and handles refunds.

Add a second entry point, not a second minting implementation. Extract/reuse the existing business rules rather than copying BFF logic. Keep mint execution, chained state, locking, and recovery out of the API/scanner lifecycle. Do not build another execution engine or introduce a new service merely to expose these operations.

The new interface is DeMi-only. Legacy remains available to existing callers during retirement; no new Legacy payment builder is introduced. Removing Legacy is a separate migration, not part of exposing this API. The existing `/mint` SubHandle relay is unchanged by this plan.

## Minimal flow

1. **Quote:** return availability and an itemized price. A quote does not reserve a handle or guarantee a mint.
2. **Build:** recheck current price, availability, and eligibility; use the caller's wallet-provided UTxO CBOR to build an unsigned order. If terms changed, return the updated terms for acceptance rather than silently increasing the charge.
3. **Sign and submit:** the caller's wallet signs and submits the transaction.
4. **Track:** expose pending payment/order, processing, minted/delivered, and refunded outcomes using existing engine state. Submission is not confirmation, and an unconfirmed transaction is not a failed transaction.

Return unsigned CBOR, required signers, a readable summary of the handle and recipient, and the price/fee breakdown. Reuse existing order/transaction identifiers for tracking; do not introduce a second session system. Client submission notifications may aid discovery but must not be required to recognize a valid order. Retrying must not register or execute an order twice. Building another unsigned transaction is not another paid order.

Accept wallet-provided unconfirmed change. Do not validate user inputs against chain-provider lookups. Preserve transaction chaining and do not add a TTL/validity interval to these orders or engine transactions. Exclude unrelated wallet assets from spending; preserve existing fixture and asset safeguards.

## Price and authorization

Use one shared pricing implementation for handle.me and API callers, based on authoritative settings. Clients cannot set the price or arbitrary partner fee destinations. Show mint charges, partner fees, network fees, and output ADA/deposits separately. No pricing framework, portable signed quotes, or new price-reservation machinery is needed by default.

Ordinary paid orders are public and rate-limited: no login or session JWT by default. A wallet transaction signature authorizes spending, not discounts or operator actions. Require verified ownership/eligibility only where a restricted benefit or owner-only operation needs it. Keep operator actions private. API keys, if needed for quotas, do not confer economic authority.

**JWT removal is conditional on a trust-boundary review.** The current session handler consumes signed price, handle, transaction, and delivery terms. Before removing that dependency, trace order validators and engine verification: prove payment amount/destination, requested handle, recipient, eligibility, allowed fee destinations, and replay protection are enforced by contracts or authoritative engine checks. Retain only necessary off-chain authorization where chain enforcement is insufficient. Tracking records are not proof of payment. Do not replace JWTs with another token format without a demonstrated need.

## Implementation gates

- Map the current BFF, minting service, engine, and validator checks; identify chain-enforced rules, required off-chain rules, and redundant historical checks.
- Confirm which handle types current DeMi supports. Start with ordinary root handles; additional types require their actual pricing and ownership rules, not a generalized abstraction in advance.
- Reuse existing competing-order/refund behavior and document it precisely before launch. Do not promise a reservation or immediate refund that the engine does not provide.
- Define concrete request/response contracts and update OpenAPI when implementing. Add behavior tests for ordinary orders, changed prices, invalid/unauthorized requests, duplicate processing, competing orders, and wallet inputs that exist only in the mempool. Run integration/e2e tests locally, not in Actions.

## Deliberately omitted

No new minting engine, Legacy API, mandatory wallet login, JWT replacement framework, new reservation service, generalized workflow system, or changes to validators/settings. Contract changes would be a separately reviewed, operator-approved scope.

[Spec index](./index.md) · [Documentation index](../index.md)
