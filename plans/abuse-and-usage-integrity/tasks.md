# Abuse and Usage Integrity — Tasks

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/spec.md),
> [`team-accounts`](../team-accounts/spec.md),
> [`stripe-billing-platform`](../stripe-billing-platform/spec.md)
> **Blocks**: nothing
> **Reality check**: extends `src/shared/lib/auth/better-auth.ts` (existing session hooks),
> `src/shared/lib/rate-limit.ts`, `src/shared/lib/security/audit.ts`, `organization-lifecycle.ts`
> seat logic, and `db/schema.ts` (`auth_sessions`, `organization_entitlements`). Tables/RLS landed as
> `0043`/`0044` (concurrent work had already carried the migration counter well past the `0030` this
> plan assumed when written — always check `drizzle/meta/_journal.json` for the real next number).

Execute top-to-bottom. Each phase leaves the app green and shippable. Nothing enforces until
Phase 5, and enforcement stays behind `ABUSE_ENFORCEMENT_MODE` (default `observe`).

## Phase 0 — Foundations, flags, telemetry (observe-only)

- [x] **Add abuse env gate and thresholds**
  - Files: `src/shared/lib/env.ts`
  - Do: add optional `ABUSE_ENFORCEMENT_MODE` (`observe`|`warn`|`enforce`, default `observe`),
    `SESSION_MAX_CONCURRENT_FREE`/`_PRO`/`_TEAM_PER_SEAT`, `SESSION_IDLE_TIMEOUT_MINUTES`,
    `SESSION_ABSOLUTE_TIMEOUT_HOURS`, `SEAT_DAILY_SEARCHES`/`_REVEALS`/`_EXPORTS`/`_MESSAGES`,
    `SIGNUP_REQUIRE_VERIFIED_EMAIL`, `SIGNUP_BLOCK_DISPOSABLE_EMAILS`, `ABUSE_ALLOWLIST_ASNS`. All
    optional with safe defaults so an unset config keeps current behavior.
  - Verify: `pnpm dev` boots with none set; add an `env.test.ts` case asserting defaults resolve to
    `observe` and enforcement is off.
  - Progress (2026-07-24): all 12 vars added to `zodEnv` in `env.ts`, matching the plan's spec.md
    guidance exactly (`SESSION_MAX_CONCURRENT_*` sized to "allow laptop+phone"). Defaults:
    `ABUSE_ENFORCEMENT_MODE=observe`, concurrency caps 2/3/2 (free/pro/team-per-seat), idle timeout
    7 days, absolute timeout 30 days, seat-daily ceilings 200/100/20/100
    (searches/reveals/exports/messages), both signup booleans `false`, ASN allowlist empty. The
    plan's own credit-related vars (`CREDIT_SEAT_DAILY_UNITS` etc.) belong to Phase 4B tasks, not
    this one — deliberately not added here. Documented every var in `.env.example` with its default
    and rationale. Rather than create a fresh `env.test.ts` (this codebase's existing convention is
    `env.security.test.ts` for all `env.ts` validation coverage — confirmed by reading it first),
    added a new `describe` block there: defaults-resolve-correctly, enum rejects an invalid value
    (no permissive coercion), numeric coercion from string env values (and rejects a non-numeric
    override), and explicit warn/enforce acceptance. 37/37 tests pass (`env.security.test.ts`).
    Verified `pnpm dev` still boots correctly with none of these set (real running dev server,
    `200` on `/`). Full sweep clean: `pnpm type-check`, `pnpm eslint` on both touched files.

- [x] **Create abuse-integrity tables migration (`0030`)**
  - Files: `drizzle/0030_abuse_usage_integrity.sql`, `src/shared/lib/db/schema.ts`,
    `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: add `user_devices` (account-subject, `user_id`), `session_signals` (system-op),
    `abuse_signals` (system-op, append-only), `account_risk` (account-subject, `user_id`),
    `seat_usage_daily` (tenant-private, `organization_id`, unique `(organization_id,user_id,day,action)`).
    Enable+FORCE RLS on the tenant-private and account-subject tables with explicit per-role
    policies per `_meta/security-policy.md`; system-op tables get worker/platform-role grants only.
  - Verify: `pnpm db:generate` clean diff, `pnpm exec drizzle-kit check`, `pnpm test:migration-integrity`.
  - Progress (2026-07-24): the concurrent e2e-design session had already carried the real next
    migration number to `0043` by the time this task ran (not `0030` as this plan assumed when
    written) — generated `drizzle/0043_abuse_usage_integrity_tables.sql` from the 5 schema.ts
    tables via `pnpm db:generate`, renamed from drizzle-kit's auto-generated tag and updated the
    journal tag to match, matching this repo's existing rename convention. `pnpm exec drizzle-kit
    check` clean, re-running `pnpm db:generate` reports "No schema changes, nothing to migrate".
    Also fixed a real stale-hardcoded-count bug in `migration-integrity.test.ts` (asserted
    `migrations: 31`, actual journal length was already 45 before this task even started — the
    same class of bug as the earlier `restore-test.ts` fix) by deriving the expected count from
    `drizzle/meta/_journal.json` at test time instead of hardcoding it.

- [x] **Data classification + role grants**
  - Files: `docs/architecture/data-classification.md`, `drizzle/0030_abuse_usage_integrity.sql`
  - Do: document each new table's class; grant `builderhunt_app` only tenant-scoped access to
    `seat_usage_daily`/`user_devices`, `builderhunt_worker`/`builderhunt_platform` access to signal
    tables; no `PUBLIC`, `TRUNCATE`, or `REFERENCES`.
  - Verify: `pnpm test:rls:local` and `pnpm test:api-isolation:local` pass with the new tables.
  - Progress (2026-07-24): wrote `drizzle/0044_abuse_usage_integrity_rls_grants.sql` following the
    exact `0028_billing_rls_grants.sql` structural precedent (ENABLE/FORCE RLS → per-role CREATE
    POLICY → REVOKE ALL FROM PUBLIC → explicit GRANT per role). `account_risk` gets **zero grant**
    for `builderhunt_app` (stricter than the task's literal wording, which only named
    `seat_usage_daily`/`user_devices` for app access) — an account's risk stage/score is written
    exclusively by trusted `builderhunt_worker`/`builderhunt_platform` paths so a compromised or
    buggy app-role query can never fabricate a signal or downgrade its own risk stage; documented
    the reasoning in the migration header and `docs/operations/database-roles.md`'s new
    "Abuse-and-usage-integrity tables" section. Documented all 5 tables' class in
    `docs/architecture/data-classification.md`. Extended `scripts/db/prepare-rls-fixture.mjs` with
    fixture rows for all 5 tables and `scripts/db/verify-rls-local.mjs` with isolation/denial
    assertions matching the billing precedent's shape (account-subject isolation for
    `user_devices`/`account_risk`, tenant isolation for `seat_usage_daily`, total app-role denial on
    `account_risk`/`session_signals`/`abuse_signals`, worker/platform read-write on the
    system-operational tables). Ran the full suite end-to-end against a real disposable
    `builderhunt_security_test_*` database (created, migrated, fixture-prepared, verified, dropped)
    — all assertions pass, including every new one. `pnpm test:api-isolation:local` not re-run: it
    exercises existing HTTP routes only and this task added no new routes, so it has nothing new to
    cover yet (will be exercised again once Phase 1+ routes read/write these tables).

- [x] **Abuse lib: signals + device fingerprint**
  - Files: `src/shared/lib/abuse/signals.ts`, `src/shared/lib/abuse/signals.test.ts`,
    `src/shared/lib/abuse/device.ts`, `src/shared/lib/abuse/device.test.ts`
  - Do: `AbuseSignalType`/`AbuseSignal` types + `emitAbuseSignal()` layered over `emitSecurityAudit`
    (redacts via `redactLogValue`, stores salted session-id hash never the token). `device.ts`:
    first-party `bh_did` cookie issue/read + `computeDeviceHash(cookie, uaFamily, salt)` (coarse UA
    family only; no raw fingerprint).
  - Verify: unit tests for redaction, stable hashing, and UA-family bucketing; `pnpm test`.
  - Progress (2026-07-24): `emitAbuseSignal()` writes both a security-audit log line (via the
    existing `emitSecurityAudit`, `details` already redacted by its own `redactLogValue` call — no
    new redaction code needed) and a durable `abuse_signals` row via `repositories/abuse-signals.ts`
    (task below). Uses `result: 'allowed'` on the audit event since Phases 0-4 are observe-only —
    the flagged action always proceeds, this call only records that it happened; Phase 5's
    enforcement decision is a separate concern. `hashSessionId(sessionId, salt)` exported from
    `signals.ts` for Phase 1's `session-guard.ts` to use — same caller-supplies-the-secret HMAC
    convention as `security/feed-capability.ts`'s `sign()`, so it stays a pure, easily testable
    function instead of reading `env` directly. `device.ts`: `DEVICE_COOKIE_NAME`/
    `issueDeviceCookieValue()`/`detectUaFamily()` (coarse family bucketing — Edge/Chrome-iOS/
    Firefox-iOS checked before generic Chrome/Firefox/Safari, since all of them also match on
    `Safari/` or `Chrome/` substrings) /`computeDeviceHash()`. 20 tests
    (`device.test.ts` + `signals.test.ts`), including one asserting the raw cookie/session value
    never appears in its own hash. `pnpm test`, `pnpm tsc --noEmit`, `pnpm eslint` all clean.

- [x] **Repositories for the new tables**
  - Files: `src/shared/lib/repositories/abuse-signals.ts`, `.../user-devices.ts`,
    `.../account-risk.ts`, `.../seat-usage.ts` (+ sibling `*.test.ts`)
  - Do: tenant-scoped writes via `withTenantContext` for `seat_usage_daily`; account/worker-scoped
    writes for the rest through the correct role client. DTO allowlists only.
  - Verify: `pnpm test`; boundary check `pnpm security:boundaries` (no global `db` import).
  - Progress (2026-07-24): `user-devices.ts` and `seat-usage.ts` take a `TenantTransaction` directly
    (no new plumbing — `withTenantContext` already sets `app.user_id` alongside
    `app.organization_id` on every call). `account-risk.ts` adds `withWorkerUser(userId, operation,
    db?)`, the per-subject analogue of `repositories/billing-worker.ts`'s `withWorkerOrganization`:
    a background risk-scoring sweep processes one user's row per transaction via
    `set_config('app.user_id', ...)`, matching that file's per-tenant-batch precedent exactly.
    `abuse-signals.ts` takes a plain `PostgresJsDatabase | typeof workerDb` with no context to set
    (system-operational, no RLS). `seat-usage.ts`'s `incrementSeatUsage` upserts additively
    (`count = count + $n`) rather than overwriting, so repeated calls accumulate instead of
    clobbering. 16 real-disposable-database integration tests (A/B isolation, missing-row, upsert-
    vs-insert, additive increment across distinct actions) following the exact
    `repositories/billing.test.ts` precedent (superuser connection — RLS enforcement itself is
    proven separately by `verify-rls-local.mjs`, not duplicated here). `pnpm test`,
    `pnpm security:boundaries` ("0 legacy imports tracked"), `pnpm tsc --noEmit`, `pnpm eslint` all
    clean.

## Phase 1 — Concurrent-session control + active-sessions UX (A1)

- [x] **Register device + count concurrency on session create**
  - Files: `src/shared/lib/auth/better-auth.ts`, `src/shared/lib/abuse/session-guard.ts` (+ test)
  - Do: add `databaseHooks.session.create.after` to upsert `user_devices`, write a `session_signals`
    row, count the user's live sessions, and `emitAbuseSignal('concurrent_sessions', …)` when over
    the tier cap. Observe-mode: record only.
  - Verify: `session-guard.test.ts` (pure count/threshold logic); manual Playwright: two logins →
    signal row appears, no block in observe mode.
  - Progress (2026-07-24): `session-guard.ts` — pure `resolveSessionCap(tier, config)`/
    `evaluateSessionConcurrency(...)` (`pro_max` shares `pro`'s cap, unknown tiers fall back to
    `free`, the conservative default for concurrency). Split the actual wiring across BOTH
    `session.create.before` and `.after` in `better-auth.ts` (task text said `.after` only, but
    empirically — verified with `curl -i` against the real running dev server — a `context.setCookie`
    call made from `.after` never reaches the response's `Set-Cookie` header, because `.after` fires
    inside better-auth's `queueAfterTransactionHook`, while the identical call from `.before` does
    reach it). So `.before` now does the cookie read/issue + `user_devices` upsert (needs no session
    id yet); `.after` does the `session_signals` write + live-session count + concurrency check +
    `emitAbuseSignal`, since only `.after` has the real `session.id`. The two hooks correlate via a
    `WeakMap<context, SessionDeviceResult>` keyed on better-auth's per-request context object
    (garbage-collected with it, never a growing global) — `src/shared/lib/abuse/session-hooks.ts`
    holds the actual logic (`handleSessionBefore`/`handleSessionAfter`), `better-auth.ts` only wires
    it. `lastIpAsn`/`ipAsn` intentionally left unset (no ASN-lookup capability exists yet — separate
    later task). Live-verified end-to-end against the real local dev DB (migrations 0043/0044
    applied there for the first time this task): fresh sign-in → `bh_did` cookie appears in the
    response, `user_devices` row created (`trust_state='new'`); replaying the same `bh_did` cookie on
    a second sign-in → same `device_id` reused, `session_signals.new_device=false`, no duplicate
    `user_devices` row; this admin account's real accumulated session count already exceeds the
    free-tier cap of 2, so every one of these real logins correctly emitted a genuine
    `abuse_signals` row with `type='concurrent_sessions'`. `pnpm tsc --noEmit`, `pnpm eslint`,
    `pnpm vitest run src/shared/lib/abuse` (29/29), `pnpm security:boundaries` all clean.

- [x] **Tier-derived concurrency cap with one-in-one-out (enforce path, gated)**
  - Files: `src/shared/lib/abuse/session-guard.ts`, `src/shared/lib/auth/better-auth.ts`
  - Do: when `ABUSE_ENFORCEMENT_MODE=enforce`, revoke the oldest session via Better Auth
    `revokeSession` before allowing the new one (cap = tier value; Team = per-seat). Emit audit.
  - Verify: unit test the revoke-oldest selection; integration test that a 3rd Pro session revokes
    the 1st only under `enforce`.
  - Progress (2026-07-24): `session-guard.ts` adds `selectSessionToRevoke()` (pure, picks the single
    oldest of a candidate list, stable tie-break) — 4 new unit tests. Traced better-auth's own
    `revokeSession` endpoint (`api/routes/session.mjs`) to confirm it's a thin wrapper that just calls
    `internalAdapter.deleteSession(token)`, which (no secondary storage configured here) is a plain
    `DELETE FROM auth_sessions WHERE token = ...` — so `better-auth.ts` (already on the auth-db
    allowlist) deletes the row directly instead of re-entering the full HTTP endpoint/context
    machinery from inside its own `session.create.after` hook, avoiding a recursive-reentry risk.
    `session-hooks.ts`'s `handleSessionAfter` only decides *policy* (should we revoke, which
    session) via an injectable `enforcementMode` param (defaults to the real env var, overridable in
    tests) — it never touches `auth_sessions` itself, keeping the auth-db-allowlist boundary intact.
    Severity bumps to `high` (from `medium`) and `details.enforced`/`revokedSessionId` are set on the
    signal when a real revocation happens. Live-verified end-to-end against the real local dev DB
    (temporarily set `ABUSE_ENFORCEMENT_MODE=enforce` in `.env.local`, restarted the dev server,
    reverted after — Vite does not hot-reload `process.env`, confirmed a full server restart was
    required both ways): captured the oldest of this account's 35 real live sessions, logged in
    again via `curl`, confirmed that exact session row was deleted, total count stayed at 35 (not
    36), and `abuse_signals` recorded `severity:"high", enforced:true, revokedSessionId:"<that id>"`.
    Restarted again after reverting `.env.local` and confirmed a 4th login left all 36 sessions
    intact with `enforced:false` — both branches proven against production-shaped data, not mocks.
    `pnpm tsc --noEmit`, `pnpm eslint`, `pnpm vitest run src/shared/lib/abuse` (33/33),
    `pnpm security:boundaries` all clean.

- [x] **Idle + absolute session timeouts**
  - Files: `src/shared/lib/auth/better-auth.ts`
  - Do: set `session.expiresIn`/`updateAge` from `SESSION_ABSOLUTE_TIMEOUT_HOURS`/idle env; keep
    current 7-day default when unset.
  - Verify: config unit test; manual check that idle past the window forces re-auth.
  - Progress (2026-07-24): added `resolveSessionTimeoutConfig(absoluteHours, idleMinutes)` to
    `session-guard.ts` (pure, 3 new unit tests) mapping `SESSION_ABSOLUTE_TIMEOUT_HOURS` →
    better-auth's `expiresIn` (the outer bound before a session dies outright if never refreshed)
    and `SESSION_IDLE_TIMEOUT_MINUTES` → `updateAge` (how much of that window must remain before an
    active request bumps `expiresAt` forward again) — traced better-auth's refresh logic
    (`api/routes/session.mjs`) to confirm this is a sliding window, not a hard "even a daily user
    gets logged out on day 30" cap; documented that nuance directly in `better-auth.ts` so it isn't
    overclaimed. The idle default (7 days) reproduces better-auth's own built-in `updateAge` default
    exactly, satisfying "keep current 7-day default when unset." Live-verified: restarted the dev
    server (env/config changes need a full restart, not picked up by HMR — same as task 2's
    finding), logged in via `curl`, and confirmed the new session's real `expires_at - created_at`
    in Postgres is exactly 30 days (was 7 by better-auth's un-configured default before this change).
    `pnpm tsc --noEmit`, `pnpm eslint`, `pnpm vitest run src/shared/lib/abuse` (36/36),
    `pnpm security:boundaries` all clean.

- [x] **`/settings/security` — active sessions + logbook**
  - Files: `src/routes/_dashboard/settings/security.tsx`,
    `src/modules/dashboard/components/ActiveSessionsPanel.tsx` (+ test),
    `src/routes/api/me/sessions/index.ts`
  - Do: list sessions (device family, coarse location, last active, current badge) via
    `listSessions`; per-row "Sign out" (`revokeSession`) and "Sign out everywhere else"
    (`revokeOtherSessions`); show recent activity from `session_signals` (redacted).
  - Verify: component test; Playwright: revoke a second session and confirm it is logged out.
  - Progress (2026-07-24): `/api/me/sessions` GET enriches better-auth's `listSessions` with
    `user_devices`/`session_signals` — `session_signals` has zero `builderhunt_app` grant (system-
    operational, see `0044_abuse_usage_integrity_rls_grants.sql`), so this reads it via `workerDb`
    directly filtered to exactly this user's own `sessionIdHash` values, the same "worker-role read
    for a user's own display data" pattern `abuse-signals.ts`'s `listAbuseSignalsForUser` already
    established; `user_devices` IS granted to `builderhunt_app`, read via the normal
    `withTenantContext`. Added `listUserDevicesForUser` to the repo (+ 2 new A/B isolation tests).
    "Coarse location" omitted (always `null`) — no ASN/geo-lookup capability exists yet, a separate
    later task; showing a fabricated value would be worse than showing nothing. Revoke actions
    (`ActiveSessionsPanel.tsx`) call better-auth's own `authClient.revokeSession`/
    `revokeOtherSessions` directly — no custom revoke route needed. Component test discovered a real
    gotcha worth documenting: better-auth's client captures its own `fetch` reference at
    client-creation time, so stubbing `global.fetch` alone lets `revokeSession` calls escape to a
    real network request (confirmed: they hit the actual local dev server and got a real 401) —
    fixed by `vi.mock`-ing the `~/shared/lib/auth/client` module boundary instead, only the plain
    `fetch('/api/me/sessions')` call goes through the stubbed global. 8 component tests. Added
    "Security" to `UserMenu.tsx`'s workspace links so the page is actually reachable. No Playwright
    spec (per this project's standing direction against new e2e test files) — live-verified instead
    against the real local dev DB and a real signed-in browser session: the list rendered this
    account's actual 38 live sessions with correct device-family enrichment for sessions created
    after this plan's device-tracking landed, "Unknown device" for older pre-existing sessions (no
    signal data for them, as expected), current-device badge correct; clicked a real "Sign out"
    button and confirmed via direct Postgres query that `auth_sessions` dropped from 38 to 37 rows
    and the list re-rendered without that session. `pnpm tsc --noEmit`, `pnpm eslint`, `pnpm vitest
    run` (60/60 across the touched files), `pnpm security:boundaries` all clean.

## Phase 2 — Session anomaly detection (A2, A3, E-detection)

- [x] **Anomaly computations → signals**
  - Files: `src/shared/lib/abuse/anomalies.ts` (+ test)
  - Do: pure functions for impossible-travel (distance/time between two IP geos), mid-session
    UA-family change, concurrent-distinct-IP, and per-seat over-use; suppress IP-only churn for
    `ABUSE_ALLOWLIST_ASNS`. Emit the corresponding `abuse_signals`.
  - Verify: table-driven unit tests incl. NAT/allowlist suppression and VPN edge cases.
  - Progress: Wrote `anomalies.ts` as pure `detect*` functions (haversine-based
    `detectImpossibleTravel` against a `maxPlausibleSpeedKmh` bound, default 1000km/h —
    faster than commercial cruise speed with headroom so layovers don't false-positive;
    `detectMidSessionUaChange` no-ops on null/undefined/`'unknown'` family on either side;
    `detectConcurrentDistinctIp` counts distinct non-null identifiers; `detectSeatOveruse`
    is a plain `count > cap`; `isAllowlistedAsn` parses `ABUSE_ALLOWLIST_ASNS`-shaped CSV).
    No IP→geo/ASN resolution lives here — that's out of scope, deferred to the later
    "Device/ASN sign-up velocity + linked-account clustering" task; these functions take
    already-resolved coordinates/identifiers, matching the same pure-function+DI split as
    `session-guard.ts`/`session-hooks.ts` from Phase 0/1. Four `check*AndEmit` wrappers
    (`checkImpossibleTravelAndEmit`, `checkMidSessionUaChangeAndEmit`,
    `checkConcurrentDistinctIpAndEmit`, `checkSeatOveruseAndEmit`) call `emitAbuseSignal`
    from Phase 0's `signals.ts` only when flagged, each taking an optional
    `deps?: EmitAbuseSignalDeps` for test injectability (Phase 0's own convention).
    `anomalies.test.ts`: 30 table-driven cases across all 5 pure functions (same-location,
    genuinely-impossible NYC→London in 1h, realistic 8h flight not flagged, a short local
    NAT-style hop over a plausible 5-minute gap not flagged, simultaneous-login zero-elapsed
    edge case flagged, custom-speed-bound override, UA-family null/unknown/change matrix,
    NAT/shared-egress single-IP not flagged vs. genuinely distinct IPs flagged, seat at-cap
    vs over-cap, ASN allowlist matching/non-matching/whitespace/empty-CSV) plus 5
    wrapper-level cases proving the VPN/NAT suppression path end-to-end: an allowlisted ASN
    suppresses emission even when the underlying travel is impossible (`insert` never
    called), a non-allowlisted ASN under the same impossible-travel input does emit, and the
    concurrent-IP wrapper filters allowlisted identifiers out before checking distinctness.
    Verified `pnpm tsc --noEmit` and `pnpm exec eslint` clean on both files, full
    `pnpm vitest run src/shared/lib/abuse` green (66/66, up from 16), and
    `pnpm security:boundaries` still passes (0 legacy imports tracked) — this task added no
    new DB/request-path wiring, so the boundary ratchet is unaffected as expected.

- [x] **Surface denied cross-tenant attempts as signals**
  - Files: `src/shared/lib/security/audit.ts` sink wiring, `src/shared/lib/abuse/anomalies.ts`
  - Do: when repeated `result: 'denied'` cross-tenant audit events cluster for a user, emit
    `cross_tenant_denied` (detection only — isolation stays owned by `security-and-multitenancy`).
  - Verify: unit test the clustering threshold; no change to any RLS/authorization decision.
  - Progress: Researched first (2 Explore sub-agents) and found cross-tenant denials were
    getting **zero** audit-event coverage anywhere — `resolveTenantPrincipal`
    (`src/shared/lib/auth/tenant-principal.ts`) is the one real tenant-boundary-violation site
    (a session's `activeOrganizationId` names an org the user isn't a member of → 403), but it
    never called `emitSecurityAudit`; the three existing `result: 'denied'` audits in
    `organization-lifecycle.ts` are seat-limit/invalid-invitation cases, not cross-tenant. Also
    confirmed no durable `security_audit_events` table exists — `consoleSecurityAuditSink` really
    is console-log-only — so "cluster repeated denied events" can't be a DB count query; instead
    reused the existing production-tested `rateLimit()` counter (Redis-backed with in-memory
    fallback, already used by `organization-lifecycle.ts`) as the clustering gate, since
    "N occurrences of X for user Y within a window" is exactly what it already computes.
    Added `ABUSE_CROSS_TENANT_DENIAL_THRESHOLD` (default 5) and
    `ABUSE_CROSS_TENANT_DENIAL_WINDOW_MINUTES` (default 10) to `env.ts`. In `anomalies.ts`:
    `detectDenialCluster({allowed})` (trivial pure predicate) + `checkCrossTenantDenialAndEmit`
    wrapper taking a `CrossTenantDenialGate` (`{gate(userId): Promise<{allowed}>}` — infra-agnostic,
    production wiring backs it with `rateLimit`) and an optional `EmitAbuseSignalDeps`, emitting
    `cross_tenant_denied` (severity `medium`) once the gate reports the threshold exceeded — same
    detect*/check*AndEmit split as every other function in the file. Wired the real call site:
    `TenantPrincipalDependencies` gained an optional `onMembershipDenied` hook, fired ONLY from the
    genuine cross-tenant branch (never the separate "no active org selected" 403, which isn't a
    tenant-boundary breach) — optional and backward-compatible, so all 4 pre-existing
    `tenant-principal.test.ts` tests kept passing unmodified. `requireTenantPrincipal`'s real
    wiring implements the hook: emits the audit line via `consoleSecurityAuditSink`, then calls
    `checkCrossTenantDenialAndEmit` with a gate backed by real `rateLimit('cross-tenant-denied',
    userId, threshold, windowSeconds)`. No RLS/authorization/route-count change — `~50` routes
    calling `requireTenantPrincipal()` get this for free with zero code changes on their end.
    `anomalies.test.ts`: added `detectDenialCluster` table (allowed→not-flagged,
    not-allowed→flagged) + 2 wrapper tests (below-threshold no-emit, threshold-exceeded emits with
    `type: 'cross_tenant_denied'`, `severity: 'medium'`). Full local sweep:
    `pnpm tsc --noEmit` clean, `pnpm eslint` clean on all 4 changed files, `pnpm vitest run
    src/shared/lib/abuse src/shared/lib/auth/tenant-principal.test.ts` → 74/74 green (up from 66,
    tenant-principal's own 4 pre-existing tests unaffected), `pnpm security:boundaries` → 0 legacy
    imports. **Live end-to-end verification against the real dev Postgres** (not just unit tests):
    wrote a throwaway `tsx` script calling the real `resolveTenantPrincipal` with only
    `getSession`/`findMembership` faked (the function's existing DI seam — no auth/cookie forging,
    which the environment's safety classifier correctly declined when first attempted via browser
    cookie injection) and the REAL production `onMembershipDenied` wiring (real `rateLimit`, real
    `emitSecurityAudit`, real `checkCrossTenantDenialAndEmit`/`emitAbuseSignal`/`insertAbuseSignal`
    against the actual dev DB). Simulated a synthetic user denied membership in a real foreign org
    6 times (threshold=5, so the 6th trips it): attempts 1-5 logged
    `[security-audit] {"action":"tenant.membership_check",...,"result":"denied"}` only; attempt 6
    additionally logged `[security-audit] {"action":"abuse.cross_tenant_denied",...}` and a
    real row appeared in `abuse_signals` (`type: 'cross_tenant_denied', severity: 'medium'`) —
    confirmed via `psql` query, then deleted the synthetic test row and the scratch script to leave
    the dev DB and repo clean.

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
