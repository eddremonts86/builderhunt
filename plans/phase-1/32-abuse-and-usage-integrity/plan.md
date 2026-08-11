# Abuse and Usage Integrity — Delivery Plan

> **Status**: `implemented`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md),
> [`team-accounts`](../27-team-accounts/spec.md),
> [`stripe-billing-platform`](../30-stripe-billing-platform/spec.md)
> **Blocks**: nothing
> **Reality check**: builds on existing `auth_sessions` (ip/ua), Better Auth session hooks/APIs,
> `organization-lifecycle.ts` seat logic, `rate-limit.ts`, and `security/audit.ts`. See
> [`spec.md`](./spec.md) for the full threat taxonomy and architecture.

## Guiding principles

1. **Measure before enforcing.** Everything ships behind `ABUSE_ENFORCEMENT_MODE=observe` first.
   No user is blocked until a real per-tier baseline exists and the enforce phase is deliberately
   flipped.
2. **Detect broadly, block narrowly.** Weak signals (shared IP) are logged; only *corroborated*
   signals escalate, honoring the OWASP NAT/proxy caveat.
3. **Reuse, don't duplicate.** Money/disputes stay in `stripe-billing-platform`; isolation stays in
   `security-and-multitenancy`. This plan consumes their contracts.
4. **Always shippable.** Each phase is independently valuable and leaves the app green.

## Phase order

### Phase 0 — Foundations, flags, telemetry (observe-only)
Add the env gate (`ABUSE_ENFORCEMENT_MODE` + thresholds) to `env.ts`, the `abuse/` lib module
(signal types, `emitAbuseSignal` on top of `emitSecurityAudit`), the four new tables
(`user_devices`, `session_signals`, `abuse_signals`, `account_risk`) + `seat_usage_daily`, their
RLS/role grants, and a first-party device cookie + salted fingerprint helper. Nothing enforces yet;
signals are only recorded. Update `docs/architecture/data-classification.md`.

### Phase 1 — Concurrent-session control + active-sessions UX (threat A1)
Enrich session creation (Better Auth `session.create.after`) to register the device, compute the
concurrent-session count, and emit a `concurrent_sessions` signal. Add tier-derived caps with
one-in-one-out revocation under `enforce`. Add idle/absolute session timeouts. Ship
`/settings/security` (active sessions list + revoke + activity logbook) using
`listSessions`/`revokeSession`/`revokeOtherSessions`.

### Phase 2 — Session anomaly detection (threats A2, A3, E-detection)
Compute impossible-travel, mid-session UA-family change, concurrent-distinct-IP, and per-seat
over-use from `session_signals` + `seat_usage_daily`; surface repeated denied cross-tenant attempts
(from existing audit denials) as `cross_tenant_denied` signals. Feed `account_risk` scoring.

### Phase 3 — Multi-accounting defenses (threat B)
Enable Better Auth email verification gate on privileged/quota actions, block disposable/plus-address
emails at sign-up, add device+ASN sign-up velocity limits (beyond the current per-IP cap), and a
linked-account clustering read model (shared device fp / IP / ASN) for admin review.

### Phase 4 — Core-value metering + rate-limit hardening (threat C)
Meter the scarce core actions (search, profile reveal, export, outbound message) into
`seat_usage_daily` with per-tier daily ceilings; re-key `rate-limit.ts` on user+org+session (not IP
alone); add export burst throttles and proportionate anti-automation checks. Converge with the
Stripe credit ledger where an action is genuinely monetary (reserve/settle), keep non-monetary
actions on the lightweight counter.

### Phase 4B — Credit / premium-feature abuse (threat family G)
Verify the already-built credit ledger's invariants hold under the real runtime role (atomic
reservation, unique monthly-window grants, idempotent grants/refunds, no negative/over-consumed
units, server-derived settlement) and add the detection the ledger does not: per-seat credit
sub-budgets in `seat_usage_daily` + `pool_drain` signal, a metering-bypass boundary test so every
provider entry point is metered, first-payer credit-consumption caps + spend-velocity into
`account_risk`, refund-farming caps + signal, a provider cost-vs-credits margin monitor
(`margin_drift`), and promo/trial grant caps per identity cluster. Detection-only under `observe`.

### Phase 5 — Enforcement ladder + admin console (threats A–G response)
Implement `resolveEnforcement(userId)` (observe→warn→stepup→throttle→block), wire the warn banner,
step-up re-auth, throttle, and block/upsell into the request path, and build the `/admin/abuse`
console with audited manual actions. Update pricing/FAQ fair-use copy.

### Phase 6 — Baseline, calibrate, and gate
Run the observe window in production, publish the per-tier baseline, tune thresholds and the ASN
allowlist, then flip `warn`→`enforce` per stage. Wire abuse checks into the release-gate audit set
alongside the five existing audits.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| False positives block legit corporate/NAT users | Medium | High | Observe-first, ASN allowlist, multi-signal corroboration, one-in-one-out before block, fast kill switch |
| Device fingerprint = privacy/legal exposure | Medium | High | Salted hashes + coarse UA only, disclose in privacy policy + consent, coordinate with `legal-and-compliance` |
| Fingerprint evasion (incognito, cookie clearing) | High | Medium | Treat fingerprint as one signal among many; lean on concurrency + volume + verified-email, not fingerprint alone |
| Metering breaks a heavy legitimate power user | Medium | Medium | Per-tier ceilings sized from the real baseline; ceilings are throttles/upsell prompts, not hard 403s at low counts |
| Over-aggressive enforcement hurts conversion | Medium | Medium | Frame as fairness + upgrade path; warn long before block; owner-visible session management |
| Duplicating Stripe/security logic | Low | Medium | Explicit non-goals; consume `billing/credits` + `can()`/RLS contracts, add only signals |
| Per-seat credit sub-budget frustrates a legit heavy seat on a Team pool | Medium | Medium | Sub-budget defaults generous, drawn from the real baseline; over-cap prompts pooled-credit request/upsell, not a hard stop, until `enforce` |
| Margin monitor misfires on a genuinely expensive-but-legit op | Low | Medium | `margin_drift` is an alert/signal, never an auto-block; feeds review, and rate cards are tuned from realized cost data |
| New tables regress tenant isolation | Low | High | Declare data class, RLS `USING`/`WITH CHECK`, tenant A/B + direct-SQL tests in CI (`test:rls:local`, `test:api-isolation:local`) |

## Rollback plan

- **Instant kill switch**: set `ABUSE_ENFORCEMENT_MODE=observe` — all enforcement stops immediately;
  signal collection continues (safe, read-mostly).
- **Per-stage rollback**: enforcement stages are independent flags; disable `block` while keeping
  `warn`/`stepup` if the block rate is too high.
- **Schema**: new tables are additive and isolated; no existing table is altered destructively, so a
  forward-recovery migration can drop them without touching auth/billing data. Session timeout and
  verification-gate changes revert by restoring the prior `better-auth.ts` config values.
- **Data**: `abuse_signals`/`session_signals` are append-only and redacted; purging them is safe and
  covered by the 30-day log-retention window already disclosed.

## Release gate (in addition to `_meta/security-policy.md` §Migration and release gate)

1. New tables pass tenant A/B + direct-SQL RLS tests as the non-owner runtime role.
2. Observe-window baseline documented before any stage is flipped to `enforce`.
3. `ABUSE_ENFORCEMENT_MODE=observe` verified to fully disable enforcement (kill-switch test).
4. Privacy-policy + consent updated and reviewed with `legal-and-compliance` before device
   fingerprinting is enabled in production.
5. `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`, `pnpm security:boundaries`,
   `pnpm test:rls:local`, `pnpm test:api-isolation:local` all green.
