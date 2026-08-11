# Delivery Plan: Trust, Claims, and Profile Removal Audit

> **Status**: `implemented`
> **Depends on**: [`audit-performance-qa`](../49-audit-performance-qa/spec.md), [`pricing-and-billing`](../31-pricing-and-billing/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md), [`claimable-profiles`](../36-claimable-profiles/spec.md)
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: Trust pages and pricing exist, but public claims drift from
> `billing-shared.ts`; claim verification proves an arbitrary email, not source ownership; and live
> federated search has no durable, global suppression layer.

## Delivery sequence

### Phase 0 — Contain current misrepresentation

Before schema work, remove the unsupported aggregate rating, user-PAT instructions, fictional or
future feature statements, and the nonfunctional alert/newsletter form. Add
`PROFILE_CLAIMS_ENABLED=false` and hide/reject new claims until source proof is live. Publish an
accurate `/security` page and link it plus `/privacy/remove` from the footer. This is independently
releasable and reduces active trust risk.

### Phase 1 — Centralize claim truth

Add the client-safe product-claims contract and tests that compare it with
`PLAN_LIMITS`/`PLAN_PRICING`, existing source adapters, and actual export code. Refactor landing,
FAQ, pricing, metadata/JSON-LD, security, and privacy copy to use or assert against it. Do not add a
second pricing component.

### Phase 2 — Add minimal removal state

Create the two new tables and indexes in a forward-only Drizzle migration. Add pure URL
normalization, HMAC/redaction, state-transition, and suppression helpers with unit tests. Existing
data remains readable; no `builders` column is added because it cannot represent global identity.

### Phase 3 — Prove source ownership

Implement fixed-host source proof adapters, then request/verify routes and the public UI. Launch
automation only for adapters with stable official endpoints. Rate-limit, conceal enumeration,
bound network work, hash secrets, and expose manual review for unsupported sources. Reuse this
helper in builder claims before re-enabling claim UI.

### Phase 4 — Enforce suppression everywhere

Filter both cache hits and misses in `search.ts`, invalidate versioned caches on verification,
reject tracking, return 404 for suppressed public profiles, and filter recent/recommendation/export/
feed/alert paths. In one DB transaction, create suppression, complete request, and delete all
per-user cached builder copies for the identity. Tests seed the same identity under two users and
in Redis/memory to prove global behavior.

### Phase 5 — Observe and roll out safely

Emit redacted request/verify/reject/suppress events and metrics. Enable request intake first,
supported-source verification second, claims last. Run browser trust tests from the performance QA
harness and a production canary using a dedicated synthetic upstream profile. Document manual
review, revocation, incident response, and the five-minute removal objective.

## Gate matrix

| Gate          | Pass condition                                                                                |
| ------------- | --------------------------------------------------------------------------------------------- |
| Copy contract | No hardcoded contradictory limit/credential/rating claim in audited surfaces.                 |
| Unit          | URL normalization, HMAC, transitions, expiry/replay, source adapters, and filters pass.       |
| Integration   | Two-user + memory/Redis/fresh-source identity disappears from every surface.                  |
| Abuse         | Wrong email/profile, replay, SSRF redirect, oversized body, and rate-limit cases fail safely. |
| Privacy       | No plaintext challenge/email in DB, logs, metrics, traces, or AI/provider payloads.           |
| Runtime       | Synthetic proof removes canary profile in ≤5 minutes and claim proof cannot be bypassed.      |

## Risks and controls

| Risk                                              | Control                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Malicious user suppresses someone else            | Require source-hosted challenge proof; email alone never authorizes.                                                     |
| Removed identity returns from cache/source        | Filter after every cache read, version cache keys, and test all downstream surfaces.                                     |
| SSRF through profile URL                          | Strict normalizer, fixed adapter hosts, no arbitrary redirects, byte/time limits.                                        |
| Minimal suppression record conflicts with erasure | Retain only HMAC/stable source identifiers under documented legitimate-interest/legal basis; no content or contact data. |
| Source API cannot expose a proof field            | Keep that source manual and pending; never weaken proof requirements.                                                    |
| Claim rollout locks legitimate users out          | Existing claims remain visible but new verified state is disabled until proof ships; provide correction support path.    |

## Rollout

1. Deploy truthful copy/security page and default-off claim/removal flags.
2. Apply additive tables and deploy read paths with suppression disabled.
3. Enable `PROFILE_REMOVAL_ENABLED` for an internal canary and one supported source.
4. Expand per source only after adapter abuse/integration tests and runtime proof pass.
5. Enable `PROFILE_CLAIMS_ENABLED` after source proof is mandatory; audit legacy verified claims
   separately rather than silently grandfathering them as strongly verified.

## Rollback

Turn off request/claim UI and POST routes via flags while continuing to enforce existing
suppressions. Never roll back by deleting suppression rows or restoring scrubbed builder caches.
The additive migration stays in place; code can revert to the previous schema-compatible version.
If filtering causes false positives, revoke only the exact suppression through an audited admin/
legal action and invalidate its cache namespace.

## Completion evidence

Attach copy-contract output, migration/integration tests, abuse-case results, DB/log redaction
sample, all-surface two-user test, canary timing, browser screenshots, and feature-flag state. Mark
the plan implemented only when claims are proof-backed and suppression remains active after a full
cache TTL and application restart.
