# Abuse and Usage Integrity — Tasks

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/spec.md),
> [`team-accounts`](../team-accounts/spec.md),
> [`stripe-billing-platform`](../stripe-billing-platform/spec.md)
> **Blocks**: nothing
> **Reality check**: extends `src/shared/lib/auth/better-auth.ts` (existing session hooks),
> `src/shared/lib/rate-limit.ts`, `src/shared/lib/security/audit.ts`, `organization-lifecycle.ts`
> seat logic, and `db/schema.ts` (`auth_sessions`, `organization_entitlements`). Next migration
> number is `0030` (last existing is `0029`).

Execute top-to-bottom. Each phase leaves the app green and shippable. Nothing enforces until
Phase 5, and enforcement stays behind `ABUSE_ENFORCEMENT_MODE` (default `observe`).

## Phase 0 — Foundations, flags, telemetry (observe-only)

- [ ] **Add abuse env gate and thresholds**
  - Files: `src/shared/lib/env.ts`
  - Do: add optional `ABUSE_ENFORCEMENT_MODE` (`observe`|`warn`|`enforce`, default `observe`),
    `SESSION_MAX_CONCURRENT_FREE`/`_PRO`/`_TEAM_PER_SEAT`, `SESSION_IDLE_TIMEOUT_MINUTES`,
    `SESSION_ABSOLUTE_TIMEOUT_HOURS`, `SEAT_DAILY_SEARCHES`/`_REVEALS`/`_EXPORTS`/`_MESSAGES`,
    `SIGNUP_REQUIRE_VERIFIED_EMAIL`, `SIGNUP_BLOCK_DISPOSABLE_EMAILS`, `ABUSE_ALLOWLIST_ASNS`. All
    optional with safe defaults so an unset config keeps current behavior.
  - Verify: `pnpm dev` boots with none set; add an `env.test.ts` case asserting defaults resolve to
    `observe` and enforcement is off.

- [ ] **Create abuse-integrity tables migration (`0030`)**
  - Files: `drizzle/0030_abuse_usage_integrity.sql`, `src/shared/lib/db/schema.ts`,
    `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: add `user_devices` (account-subject, `user_id`), `session_signals` (system-op),
    `abuse_signals` (system-op, append-only), `account_risk` (account-subject, `user_id`),
    `seat_usage_daily` (tenant-private, `organization_id`, unique `(organization_id,user_id,day,action)`).
    Enable+FORCE RLS on the tenant-private and account-subject tables with explicit per-role
    policies per `_meta/security-policy.md`; system-op tables get worker/platform-role grants only.
  - Verify: `pnpm db:generate` clean diff, `pnpm exec drizzle-kit check`, `pnpm test:migration-integrity`.

- [ ] **Data classification + role grants**
  - Files: `docs/architecture/data-classification.md`, `drizzle/0030_abuse_usage_integrity.sql`
  - Do: document each new table's class; grant `builderhunt_app` only tenant-scoped access to
    `seat_usage_daily`/`user_devices`, `builderhunt_worker`/`builderhunt_platform` access to signal
    tables; no `PUBLIC`, `TRUNCATE`, or `REFERENCES`.
  - Verify: `pnpm test:rls:local` and `pnpm test:api-isolation:local` pass with the new tables.

- [ ] **Abuse lib: signals + device fingerprint**
  - Files: `src/shared/lib/abuse/signals.ts`, `src/shared/lib/abuse/signals.test.ts`,
    `src/shared/lib/abuse/device.ts`, `src/shared/lib/abuse/device.test.ts`
  - Do: `AbuseSignalType`/`AbuseSignal` types + `emitAbuseSignal()` layered over `emitSecurityAudit`
    (redacts via `redactLogValue`, stores salted session-id hash never the token). `device.ts`:
    first-party `bh_did` cookie issue/read + `computeDeviceHash(cookie, uaFamily, salt)` (coarse UA
    family only; no raw fingerprint).
  - Verify: unit tests for redaction, stable hashing, and UA-family bucketing; `pnpm test`.

- [ ] **Repositories for the new tables**
  - Files: `src/shared/lib/repositories/abuse-signals.ts`, `.../user-devices.ts`,
    `.../account-risk.ts`, `.../seat-usage.ts` (+ sibling `*.test.ts`)
  - Do: tenant-scoped writes via `withTenantContext` for `seat_usage_daily`; account/worker-scoped
    writes for the rest through the correct role client. DTO allowlists only.
  - Verify: `pnpm test`; boundary check `pnpm security:boundaries` (no global `db` import).

## Phase 1 — Concurrent-session control + active-sessions UX (A1)

- [ ] **Register device + count concurrency on session create**
  - Files: `src/shared/lib/auth/better-auth.ts`, `src/shared/lib/abuse/session-guard.ts` (+ test)
  - Do: add `databaseHooks.session.create.after` to upsert `user_devices`, write a `session_signals`
    row, count the user's live sessions, and `emitAbuseSignal('concurrent_sessions', …)` when over
    the tier cap. Observe-mode: record only.
  - Verify: `session-guard.test.ts` (pure count/threshold logic); manual Playwright: two logins →
    signal row appears, no block in observe mode.

- [ ] **Tier-derived concurrency cap with one-in-one-out (enforce path, gated)**
  - Files: `src/shared/lib/abuse/session-guard.ts`, `src/shared/lib/auth/better-auth.ts`
  - Do: when `ABUSE_ENFORCEMENT_MODE=enforce`, revoke the oldest session via Better Auth
    `revokeSession` before allowing the new one (cap = tier value; Team = per-seat). Emit audit.
  - Verify: unit test the revoke-oldest selection; integration test that a 3rd Pro session revokes
    the 1st only under `enforce`.

- [ ] **Idle + absolute session timeouts**
  - Files: `src/shared/lib/auth/better-auth.ts`
  - Do: set `session.expiresIn`/`updateAge` from `SESSION_ABSOLUTE_TIMEOUT_HOURS`/idle env; keep
    current 7-day default when unset.
  - Verify: config unit test; manual check that idle past the window forces re-auth.

- [ ] **`/settings/security` — active sessions + logbook**
  - Files: `src/routes/_dashboard/settings/security.tsx`,
    `src/modules/dashboard/components/ActiveSessionsPanel.tsx` (+ test),
    `src/routes/api/me/sessions/index.ts`
  - Do: list sessions (device family, coarse location, last active, current badge) via
    `listSessions`; per-row "Sign out" (`revokeSession`) and "Sign out everywhere else"
    (`revokeOtherSessions`); show recent activity from `session_signals` (redacted).
  - Verify: component test; Playwright: revoke a second session and confirm it is logged out.

## Phase 2 — Session anomaly detection (A2, A3, E-detection)

- [ ] **Anomaly computations → signals**
  - Files: `src/shared/lib/abuse/anomalies.ts` (+ test)
  - Do: pure functions for impossible-travel (distance/time between two IP geos), mid-session
    UA-family change, concurrent-distinct-IP, and per-seat over-use; suppress IP-only churn for
    `ABUSE_ALLOWLIST_ASNS`. Emit the corresponding `abuse_signals`.
  - Verify: table-driven unit tests incl. NAT/allowlist suppression and VPN edge cases.

- [ ] **Surface denied cross-tenant attempts as signals**
  - Files: `src/shared/lib/security/audit.ts` sink wiring, `src/shared/lib/abuse/anomalies.ts`
  - Do: when repeated `result: 'denied'` cross-tenant audit events cluster for a user, emit
    `cross_tenant_denied` (detection only — isolation stays owned by `security-and-multitenancy`).
  - Verify: unit test the clustering threshold; no change to any RLS/authorization decision.

- [ ] **Risk scoring**
  - Files: `src/shared/lib/abuse/risk.ts` (+ test), `src/shared/lib/repositories/account-risk.ts`
  - Do: combine signals into a decayed `account_risk` score + candidate stage; corroboration rules
    (no single weak signal escalates past `warn`).
  - Verify: unit tests for scoring, decay, and corroboration gates.

## Phase 3 — Multi-accounting defenses (B)

- [ ] **Email verification gate**
  - Files: `src/shared/lib/auth/better-auth.ts`, `src/shared/lib/email.ts`
  - Do: enable Better Auth email verification; when `SIGNUP_REQUIRE_VERIFIED_EMAIL`, require verified
    email before quota/paid actions (not before basic login, to avoid lockout).
  - Verify: integration test that an unverified account is blocked from a gated action only.

- [ ] **Disposable / plus-address email blocking**
  - Files: `src/shared/lib/abuse/email-hygiene.ts` (+ test), `src/shared/lib/auth/better-auth.ts`
  - Do: normalize plus-addresses for duplicate detection and reject known disposable domains at
    sign-up when `SIGNUP_BLOCK_DISPOSABLE_EMAILS`.
  - Verify: unit tests for normalization + a sampled disposable-domain list; sign-up rejection test.

- [ ] **Device/ASN sign-up velocity + linked-account clustering**
  - Files: `src/shared/lib/rate-limit.ts`, `src/shared/lib/abuse/linked-accounts.ts` (+ test),
    `src/routes/api/admin/abuse/clusters.ts`
  - Do: extend sign-up limiting to key on device hash + ASN (not IP alone); build a read model that
    clusters accounts sharing device/IP/ASN for admin review.
  - Verify: unit test cluster grouping; rate-limit test that device+ASN caps hold under IP rotation.

## Phase 4 — Core-value metering + rate-limit hardening (C)

- [ ] **Meter scarce core actions per seat**
  - Files: `src/lib/search.ts`, `src/routes/api/export/builders.ts`,
    profile-reveal + outreach send paths, `src/shared/lib/repositories/seat-usage.ts`
  - Do: increment `seat_usage_daily` per (org,user,day,action); read per-tier ceilings from env.
    Observe: count only. Converge monetary actions with the Stripe `billing/credits` reserve/settle
    contract; keep non-monetary read actions on this counter.
  - Verify: unit tests for counter increments + ceiling math; search/export still work in observe.

- [ ] **Re-key rate limiting on identity, not IP alone**
  - Files: `src/shared/lib/rate-limit.ts`, `src/shared/lib/rate-limit.test.ts`
  - Do: add `getRateLimitId` variants that compose authenticated `userId` + `organizationId` +
    session hash; apply on authed endpoints so IP rotation cannot reset an authed bucket.
  - Verify: `rate-limit.test.ts` proves an authed user is limited across changing IPs.

- [ ] **Export burst throttle + proportionate anti-automation**
  - Files: `src/routes/api/export/builders.ts`, `src/shared/lib/abuse/anti-automation.ts` (+ test)
  - Do: cap exports/day per seat, add an `export_burst` signal, and add lightweight automation
    heuristics (missing/implausible headers, non-interactive cadence) that raise signals, not blocks.
  - Verify: unit tests; export beyond the daily cap emits a signal (and 429 only under `enforce`).

## Phase 4B — Credit / premium-feature abuse (G)

- [ ] **Verify built credit-ledger invariants under the real runtime role (G3/G5/G9/G10)**
  - Files: `scripts/db/verify-api-isolation-local.mjs`, `src/shared/lib/billing/reservations.test.ts`,
    `src/shared/lib/repositories/billing-ledger.ts`
  - Do: add adversarial checks as `builderhunt_app` — concurrent `reserveCredits` never overspends;
    balance never negative; a monthly-window grant is unique per subscription/window/type; a replayed
    idempotency key returns the cached result (no second grant/refund); `settleReservation` cannot
    settle more than reserved and `actualUnits` is server-derived (not client-widened).
  - Verify: `pnpm test` (new reservation/ledger cases) + `pnpm test:api-isolation:local` green;
    document each verified invariant.

- [ ] **Per-seat credit sub-budget + `pool_drain` signal (G2)**
  - Files: `src/shared/lib/billing/reservations.ts`, `src/shared/lib/repositories/seat-usage.ts`,
    `src/shared/lib/abuse/credit-abuse.ts` (+ test)
  - Do: on each reservation, record the acting seat's credit units into `seat_usage_daily`; when a
    small number of seats consume a disproportionate share of a Team pool, emit `pool_drain`. Observe:
    record + signal only; `enforce` applies `CREDIT_SEAT_DAILY_UNITS` as a per-seat sub-cap.
  - Verify: unit tests for the share computation + sub-cap math; no change to pooled total in observe.

- [ ] **Metering-bypass boundary test — every provider entry point is metered (G8)**
  - Files: `scripts/check-provider-metering.mjs`, `package.json` (script), `.github/workflows/quality.yml`
  - Do: static check that every server path calling MiniMax/embeddings (`ai/minimax.ts`,
    `ai/embeddings.ts`) is reached only through `reserveCredits`/`checkAndConsumeBudget`, with an
    explicit allowlist for the free local (Chrome) tier. Fail CI on an un-metered provider call.
  - Verify: `node scripts/check-provider-metering.mjs` exits 0 on the current tree; add a failing fixture.

- [ ] **First-payer credit-consumption cap + spend-velocity signal (G6)**
  - Files: `src/shared/lib/billing/reservations.ts`, `src/shared/lib/abuse/credit-abuse.ts`,
    `src/shared/lib/abuse/risk.ts`
  - Do: cap credit consumption for a new payer / new payment method to `CREDIT_FIRST_PAYER_CAP_UNITS`
    within `CREDIT_FIRST_PAYER_WINDOW_HOURS`; feed a spend-velocity input into `account_risk` so a
    buy→burn burst can gate high-cost ops behind step-up. Coordinate with Stripe Radar (do not duplicate).
  - Verify: unit tests for the first-payer window + cap; integration test that observe mode never blocks.

- [ ] **Refund-farming cap + `refund_farming` signal (G4)**
  - Files: `src/shared/lib/billing/reservations.ts` (`refundUsage` path),
    `src/shared/lib/abuse/credit-abuse.ts` (+ test)
  - Do: require provider-evidence for a usage refund, make it idempotent per settlement, cap refunds
    per account/day at `CREDIT_REFUND_MAX_PER_DAY`, and emit `refund_farming` on a high
    refund-to-settle ratio.
  - Verify: unit tests: a second refund for the same settlement is rejected; ratio threshold fires a signal.

- [ ] **Provider cost-vs-credit margin monitor + `margin_drift` signal (G7)**
  - Files: `src/shared/lib/abuse/margin.ts` (+ test), `src/shared/lib/ai/minimax.ts` (cost capture)
  - Do: record estimated provider cost per settled op; when provider cost ÷ credits charged exceeds
    `CREDIT_MARGIN_ALERT_RATIO`, emit `margin_drift` (alert only, never auto-block). Confirm each op's
    reserved max covers worst-case provider cost and max output tokens are capped per `_meta/ai-policy.md`.
  - Verify: unit tests for the ratio + a capped-max-tokens assertion per server AI task.

- [ ] **Promo/trial grant caps per identity cluster (G1)**
  - Files: `src/shared/lib/abuse/linked-accounts.ts`, promo/trial grant path in `billing/*`
  - Do: before minting a promo or manual-trial grant, cap total grants per device/payment/identity
    cluster at `PROMO_GRANT_MAX_PER_CLUSTER`; emit `credit_farming` when the cap is hit.
  - Verify: unit test that a second clustered account cannot claim the same promo beyond the cap.

## Phase 5 — Enforcement ladder + admin console (A–G response)

- [ ] **`resolveEnforcement()` policy + request wiring**
  - Files: `src/shared/lib/abuse/enforcement.ts` (+ test), `src/shared/lib/auth/tenant-principal.ts`
  - Do: single policy mapping risk+mode → `observe|warned|stepup|throttled|blocked`; wire a check
    into authed request resolution so a stage applies consistently (warn banner flag, step-up
    required, tighter limits, or session revocation + upsell).
  - Verify: unit tests for every stage transition; integration test that `observe` is a no-op.

- [ ] **Warn banner + step-up re-auth UX**
  - Files: `src/modules/dashboard/components/AbuseWarningBanner.tsx` (+ test),
    `src/routes/_dashboard/route.tsx`, `src/routes/api/me/stepup/index.ts`
  - Do: show a fairness-framed banner at `warned`; require password/verified-email re-auth at
    `stepup` before the next sensitive action.
  - Verify: component test; Playwright: forced `stepup` prompts re-auth once, then proceeds.

- [ ] **Platform-admin abuse console**
  - Files: `src/routes/api/admin/abuse/index.ts`, `src/routes/_dashboard/admin/abuse.tsx`,
    `src/modules/dashboard/components/AbuseConsole.tsx` (+ test)
  - Do: `abuse_signals` feed + linked-account clusters + per-account stage; manual actions (clear,
    warn, force step-up, block), each audited via `emitSecurityAudit` behind
    `requirePlatformAdminPrincipal`.
  - Verify: route-coverage (`pnpm security:route-coverage`), admin-only access test, audit-row test.

- [ ] **Pricing/FAQ fair-use copy**
  - Files: `src/routes/_landing/pricing.tsx`
  - Do: state the seat/fair-use and per-seat concurrency policy so enforcement is expected.
  - Verify: content test / visual check.

## Phase 6 — Baseline, calibrate, gate

- [ ] **Observe-window baseline report**
  - Files: `scripts/abuse/baseline-report.ts`, `docs/operations/abuse-baseline.md`
  - Do: query `session_signals`/`abuse_signals`/`seat_usage_daily` for per-tier medians (devices,
    IPs, actions per seat); document recommended thresholds + ASN allowlist.
  - Verify: script runs against a seeded DB; doc committed before any `enforce` flip.

- [ ] **Privacy/consent update (with `legal-and-compliance`)**
  - Files: `src/routes/_landing/legal/privacy.tsx`, consent surface
  - Do: disclose device fingerprinting (salted hashes, coarse UA) and its abuse-prevention purpose;
    align retention with the existing 30-day window.
  - Verify: legal review sign-off recorded; privacy page renders the new disclosure.

- [ ] **Wire abuse checks into the release-gate audit set**
  - Files: `.github/workflows/quality.yml`, `docs/operations/*`
  - Do: add the RLS/isolation tests for new tables and a kill-switch smoke (`ABUSE_ENFORCEMENT_MODE=observe`
    disables enforcement) to CI; treat as a recurring gate like the five audits.
  - Verify: CI green; kill-switch test proves enforcement fully disables.

- [ ] **Staged enforce rollout**
  - Files: deployment config (Coolify env)
  - Do: flip `observe`→`warn`, monitor false positives via `abuse_signals` + support tags, then
    enable `stepup`/`throttle`/`block` stage by stage; keep instant rollback to `observe`.
  - Verify: post-flip monitoring shows no allowlisted-ASN false-positive blocks; support-ticket rate
    within the agreed threshold.
