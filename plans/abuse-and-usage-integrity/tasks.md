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

- [x] **Risk scoring**
  - Files: `src/shared/lib/abuse/risk.ts` (+ test), `src/shared/lib/repositories/account-risk.ts`
  - Do: combine signals into a decayed `account_risk` score + candidate stage; corroboration rules
    (no single weak signal escalates past `warn`).
  - Verify: unit tests for scoring, decay, and corroboration gates.
  - Progress: New `risk.ts`. `computeDecayedRiskScore(signals, now, halfLifeHours=72)` sums each
    signal's severity weight (low=1/medium=3/high=7) decayed exponentially by age
    (`weight * 0.5^(ageHours/halfLife)`) — a signal's contribution halves every 72h rather than
    being dropped at a hard cutoff. `computeCandidateRiskStage` maps the score to a `RiskStage`
    (`observe`/`warned`/`stepup`/`throttled`/`blocked` — exactly `account_risk.stage`'s check
    constraint) via fixed thresholds (4/12/25/40), then applies the spec.md-mandated corroboration
    gate verbatim: *"a single weak signal ... never escalates past `warn`; escalation requires
    corroborating signals"* — implemented as `distinctSignalTypes < MIN_CORROBORATING_SIGNAL_TYPES
    (2)` caps the candidate stage at `warned` regardless of how high the raw score is, even from
    20 repeated high-severity signals of the SAME type (explicit test: score >40 by itself, but
    stays `warned` because `distinctSignalTypes === 1`). "Candidate" stage deliberately, since
    deciding whether/how to actually act on it is the enforcement ladder's job
    (`resolveEnforcement()`, Phase 5, not built yet). `recomputeAccountRisk(transaction, userId,
    deps?)` composes `listAbuseSignalsForUser` (read, plain `workerDb` default — `abuse_signals`
    has no RLS/tenant context to inherit) with `upsertAccountRisk` (write, via the caller's
    RLS-scoped `WorkerTransaction` — `account_risk.stage`/`.riskScore` are written through
    `withWorkerUser`'s `app.user_id` scoping same as every other account-risk write); no change
    needed to `repositories/account-risk.ts` itself, `getAccountRisk`/`upsertAccountRisk` were
    already sufficient. `risk.test.ts`: 12 pure-function tests (zero signals, severity ordering,
    exact decay at 1 and 2 half-lives, custom half-life, summing not averaging, scoring
    thresholds, the corroboration gate at 1/exactly-2/3+ distinct types, and confirming
    corroboration never artificially demotes a genuinely-low score) + 2 real-disposable-DB
    integration tests for `recomputeAccountRisk` (real `abuse_signals` rows in → real scored
    `account_risk` upsert out, matching `stored` via `getAccountRisk`; a user with zero signals
    lands at `observe`/score 0/`reason: null`). Full sweep: `pnpm tsc --noEmit` clean, `pnpm eslint`
    clean, `pnpm vitest run src/shared/lib/abuse src/shared/lib/repositories/account-risk.test.ts
    src/shared/lib/repositories/abuse-signals.test.ts src/shared/lib/auth/tenant-principal.test.ts`
    → 99/99 green, `pnpm security:boundaries` → 0 legacy imports.

## Phase 3 — Multi-accounting defenses (B)

- [ ] **Email verification gate**
  - Files: `src/shared/lib/auth/better-auth.ts`, `src/shared/lib/email.ts`
  - Do: enable Better Auth email verification; when `SIGNUP_REQUIRE_VERIFIED_EMAIL`, require verified
    email before quota/paid actions (not before basic login, to avoid lockout).
  - Verify: integration test that an unverified account is blocked from a gated action only.

- [x] **Disposable / plus-address email blocking**
  - Files: `src/shared/lib/abuse/email-hygiene.ts` (+ test), `src/shared/lib/auth/better-auth.ts`
  - Do: normalize plus-addresses for duplicate detection and reject known disposable domains at
    sign-up when `SIGNUP_BLOCK_DISPOSABLE_EMAILS`.
  - Verify: unit tests for normalization + a sampled disposable-domain list; sign-up rejection test.
  - Progress: Skipped the preceding "Email verification gate" task in this pass — its file list
    includes `src/shared/lib/email.ts`, reserved for a concurrent session this whole plan run has
    been avoiding; will need a maintainer/second pass to pick up. New `email-hygiene.ts`:
    `normalizeEmailForDuplicateDetection` (lowercase + strip `+tag` local-part suffix, dots left
    alone since dot-folding is Gmail-specific and would be wrong for every other provider) and a
    sampled ~40-domain `DISPOSABLE_EMAIL_DOMAINS` set (mailinator/guerrillamail/10minutemail/etc. —
    a deterrent against the common case, never claimed exhaustive) behind `isDisposableEmailDomain`.
    Researched (1 Explore sub-agent reading actual better-auth 1.6.23 source,
    `dist/db/with-hooks.mjs`/`dist/api/routes/sign-up.mjs`) to confirm the correct rejection seam:
    `databaseHooks.user.create.before` throwing an `APIError` propagates verbatim to the sign-up
    endpoint's caller and aborts the transaction (no user row created) — `.after` (already used for
    `ensurePersonalOrganization`) cannot abort, same "before can block, after cannot" split already
    established for `session.create` in Phase 1. Wired `checkSignupEmailGate` (throws
    `DisposableEmailRejectedError`, kept separate from the `APIError` translation so the pure gate
    stays framework-agnostic and unit-testable) into a new `create.before` in `better-auth.ts`,
    gated on `env.SIGNUP_BLOCK_DISPOSABLE_EMAILS`. `email-hygiene.test.ts`: 21 tests — normalization
    table (case/whitespace/plus-strip/multi-plus/dots-preserved/malformed-input), disposable-domain
    table (case-insensitive match, custom list override, malformed input never matches), and the
    gate itself (silent for normal emails regardless of flag, silent for disposable emails when the
    flag is off, throws when both apply). Full sweep: `pnpm tsc --noEmit` clean, `pnpm eslint`
    clean, `pnpm vitest run src/shared/lib/abuse/email-hygiene.test.ts src/shared/lib/auth` → 101/101
    green, `pnpm security:boundaries` → 0 legacy imports. **Live-verified against the real dev
    server** (not just unit tests): browser-based sign-up became unreliable mid-session (a
    concurrent session's edits to `__root.tsx`/`globals.css`/`ThemeProvider.tsx` triggered repeated
    HMR full-remounts that wiped the sign-up form's local state between fill and submit), so
    verified via direct `curl -X POST /api/auth/sign-up/email` against the same running server
    instead — same code path, no UI involved. With `SIGNUP_BLOCK_DISPOSABLE_EMAILS=true` (temporary
    `.env.local` override + the standard dev-server restart this plan has needed every time, since
    Vite doesn't hot-reload `process.env`): a `mailinator.com` address got `400 BAD_REQUEST
    {"message":"Disposable email addresses are not allowed.","code":"DISPOSABLE_EMAIL_NOT_ALLOWED"}`
    and no user row was created; a normal `example.com` address in the same run still succeeded
    (`200`, session cookie issued) — confirming the gate doesn't collaterally block legitimate
    sign-ups. Reverted the env override, restarted the server, confirmed the same `mailinator.com`
    address now succeeds again (flag back to its `false` default), and deleted every test user
    created during verification (`psql DELETE FROM auth_users WHERE email IN (...)`) to leave the
    dev database clean.

- [x] **Device/ASN sign-up velocity + linked-account clustering**
  - Files: `src/shared/lib/rate-limit.ts`, `src/shared/lib/abuse/linked-accounts.ts` (+ test),
    `src/routes/api/admin/abuse/clusters.ts`
  - Do: extend sign-up limiting to key on device hash + ASN (not IP alone); build a read model that
    clusters accounts sharing device/IP/ASN for admin review.
  - Verify: unit test cluster grouping; rate-limit test that device+ASN caps hold under IP rotation.
  - Progress: **ASN scope decision** — checked with the user before building: this codebase has
    zero IP→ASN resolution capability (no geo-IP dependency installed), so real ASN clustering
    would mean picking and adding a new external dependency/vendor. User chose device+IP only,
    ASN explicitly deferred (same honest-deferral pattern as `anomalies.ts`/`session-hooks.ts`).
    **Two security-boundary questions also confirmed with the user before proceeding**: (1)
    reading `auth_sessions.ip_address` needs a new narrow auth-db-allowlisted repository file —
    approved; (2) cross-user device clustering needs `builderhunt_worker` to read `user_devices`
    across ALL users, but it had zero grant on that table at all (only `builderhunt_app`,
    scoped to its own `app.user_id`) — approved a new migration granting it unscoped SELECT.
    **New migration `0045_user_devices_worker_read_grant.sql`**: `CREATE POLICY
    user_devices_worker_select ... USING (true)` + `GRANT SELECT` for `builderhunt_worker` —
    SELECT only, INSERT/UPDATE/DELETE stay exclusively with `builderhunt_app`, unlike
    `account_risk`'s worker policy (stays `user_id`-scoped) there's no single subject to scope a
    clustering read by. Applied via `drizzle-kit migrate`; confirmed the policy live with `\d+
    user_devices`. Did **not** run the full `test:rls:local` fixture rehearsal against this shared
    dev cluster — `prepare-rls-fixture.mjs` mutates cluster-wide role passwords
    (`ALTER ROLE ... PASSWORD`), which would have broken a concurrent session's dev server using
    the same local Postgres; instead verified directly with the real `builderhunt_worker`/`builderhunt_app`
    credentials from `.env` (no mutation): worker sees all 35 device rows unscoped, app sees 0
    with no `app.user_id` context set — matches the policy's intent exactly. Extended
    `verify-rls-local.mjs`'s existing `user_devices` block with the worker-cross-user-read +
    worker-insert-denied assertions for whenever that fixture *is* run (CI, or an isolated
    environment).
    **New `repositories/auth-sessions-worker.ts`** (added to `check-tenant-boundaries.mjs`'s
    `authDbAllowlist`, same narrow-exception shape as `account-privacy.ts`/`alerts-worker.ts`):
    `listRecentSessionIps(sinceDate, limit)` — bounded, read-only `auth_sessions.ip_address`.
    **Extended `repositories/user-devices.ts`** with `listRecentDeviceHashesAcrossUsers` (worker-only,
    bounded by `lastSeenAt`/`limit`).
    **New `abuse/linked-accounts.ts`**: `clusterLinkedAccounts` — union-find over
    `(userId, deviceHash?, ipAddress?)` associations; two accounts land in one cluster if they
    share ANY device hash or IP, transitively (A~B via device, B~C via IP → one cluster of 3).
    Singleton "clusters" (nothing shared with anyone) are dropped. `findLinkedAccountClusters`
    composes the two read models into the flat clustering input. Detection/admin-review only —
    never influences authorization.
    **New `api/admin/abuse/clusters.ts`**: `GET`, `requirePlatformAdminPrincipal`-gated, optional
    `?windowDays=` (default 30), returns `{windowDays, clusters}`.
    **Device-hash-keyed sign-up rate limiting**: extended `better-auth.ts`'s existing
    `user.create.before` hook (already used for the disposable-email gate) to also read/issue the
    `bh_did` cookie and call `rateLimit('signup-device', deviceHash, SIGNUP_DEVICE_DAILY_LIMIT,
    24h)` (new env var, default 3/day) — survives IP rotation, unlike better-auth's own built-in
    per-IP sign-up limiter. Researched via Explore sub-agent that `context.headers`/
    `context.request?.headers` (not `user.userAgent`, which doesn't exist) is how to read the
    incoming UA from a `user.create.before` hook in better-auth 1.6.23.
    **Bug found and fixed during live verification**: a brand-new sign-up's `user.create.before`
    (rate-limit check) and `session.create.before` (existing device-recognition upsert from Phase 1)
    each independently issued their OWN fresh `bh_did` value when no cookie existed yet — since
    `context.getCookie` only reads the ORIGINAL incoming request, never a value set earlier in the
    same request by another hook's `context.setCookie`. This produced two conflicting
    `Set-Cookie: bh_did=...` headers in one response (a real browser keeps only the last one) — the
    two hooks disagreed about the device's identity for that exact request. Fixed with a
    `pendingSignupDeviceCookie` `WeakMap<object, string>` (same per-request `context`-object
    correlation pattern as the existing `pendingSessionDevices` map): `user.create.before` records
    what it issued, `session.create.before` checks the map first and reuses that value instead of
    issuing a second one. Confirmed fixed live: a fresh sign-up now sets exactly one `bh_did`
    cookie, and `user_devices` gets exactly one consistent device row.
    **Tests**: `linked-accounts.test.ts` (11 cases — empty input, lone account not clustered,
    disjoint accounts not clustered, device-only cluster, IP-only cluster, 3-way transitive
    clustering across different identifier types, two independent clusters not merged, null/undefined
    identifiers ignored, a shared identifier reported only when 2+ *final-cluster* members actually
    share it, size-descending sort, and the `findLinkedAccountClusters` composition wiring).
    New `rate-limit.test.ts` (4 cases, this function had no tests before): basic cap/deny, distinct
    ids tracked independently, window reset, and the task-mandated "device-hash cap holds across
    IP rotation" case (same `id`, four different *simulated* client IPs — the point being `rateLimit`
    never takes IP as input at all, so keying on device hash instead of IP is inherently immune to
    IP rotation).
    **Full local sweep**: `pnpm tsc --noEmit` clean, `pnpm eslint` clean on all 9 changed/new
    source files, `pnpm vitest run src/shared/lib/abuse src/shared/lib/repositories/user-devices.test.ts
    src/shared/lib/rate-limit.test.ts src/shared/lib/auth/tenant-principal.test.ts
    src/routes/api/admin/abuse --no-file-parallelism` → 134/134 green (ran with reduced
    parallelism after hitting real Postgres connection-limit contention — 203/200 connections,
    traced to an orphaned dev-server process from an earlier `preview_stop` in this same session
    that hadn't released its connections; killed it, connections dropped to 93, unrelated to this
    task's code), `pnpm security:boundaries` → 0 legacy imports (confirms the new
    `auth-sessions-worker.ts` allowlist entry didn't open anything unintended).
    **Live end-to-end verification against the real dev server + Postgres** (not just unit tests):
    (1) sign-up device cap — 4 sign-ups sharing one persisted `bh_did` cookie (via a curl cookie
    jar, with an `Origin` header to satisfy better-auth's pre-existing CSRF origin-check, which
    only triggers once a Cookie header is present — unrelated to this task) succeeded, the 4th
    hitting the cap failed with `429 {"code":"SIGNUP_DEVICE_RATE_LIMITED"}`, exactly matching the
    default limit of 3; (2) the cookie-sync fix — confirmed a fresh sign-up now emits exactly one
    `Set-Cookie: bh_did=...` and one consistent `user_devices` row; (3) clustering — created two
    real users sharing one device cookie, ran `findLinkedAccountClusters` against the real dev DB,
    got back a real cluster containing both (plus every other locally-tested account, since all
    local dev traffic shares `127.0.0.1` — expected, and itself a live demonstration of the
    OWASP NAT caveat this whole plan is built around: IP alone over-clusters on shared egress,
    which is exactly why `risk.ts`'s corroboration gate requires 2+ *distinct* signal types before
    escalating, not just one indiscriminate one). Deleted every test user/cookie/scratch script
    created during verification afterward.

## Phase 4 — Core-value metering + rate-limit hardening (C)

- [x] **Meter scarce core actions per seat**
  - Files: `src/lib/search.ts`, `src/routes/api/export/builders.ts`,
    profile-reveal + outreach send paths, `src/shared/lib/repositories/seat-usage.ts`
  - Do: increment `seat_usage_daily` per (org,user,day,action); read per-tier ceilings from env.
    Observe: count only. Converge monetary actions with the Stripe `billing/credits` reserve/settle
    contract; keep non-monetary read actions on this counter.
  - Verify: unit tests for counter increments + ceiling math; search/export still work in observe.
  - Progress: Researched via Explore sub-agent to find the exact 4 integration points before
    writing anything. Findings that shaped scope: (1) `src/lib/search.ts`'s `searchBuilders` is a
    plain function with no tenant context — metering had to go in its caller,
    `api/search/builders.ts`, where a best-effort `TenantPrincipal` is already resolved (anonymous
    search stays un-metered, correctly — there's no seat to attribute it to). (2) The
    `seat_usage_daily.action` check constraint is `'searches'|'reveals'|'exports'|'messages'` — one
    row per action-*event*, not per result-row, confirmed by the existing `SEAT_DAILY_EXPORTS`
    naming (per-seat daily event cap, not a row-count cap) — export increments once per download
    click, not once per CSV row. (3) "Profile-reveal" has no code literally named "reveal"; the
    real analog is `api/builders/$builderId.ts`'s `GET` handler's tenant branch (returns an org's
    private/enriched builder metadata — language/country/topics — to a recruiter who tracked that
    builder). (4) **"Outreach send" doesn't exist as a server-side action** — grepped
    `outreach`/`send` across the whole tree; `OutreachCopilot.tsx`'s `handleCopy` explicitly does
    `navigator.clipboard.writeText` only, with a code comment stating *"Nothing is sent
    automatically — review and copy the draft yourself"*. There is no send endpoint to meter.
    Documented this gap rather than fabricating a metering hook for a feature that doesn't exist;
    `'messages'` stays a defined-but-currently-unused action until a real send path is built.
    **`abuse/anomalies.ts`**: added `meterSeatActionAndEmit(transaction, {organizationId, userId,
    action, cap, requestId}, deps?)` — the single entry point every metered route calls, composing
    the existing `incrementSeatUsage` repo call with the existing `checkSeatOveruseAndEmit` (so the
    increment-then-check sequence is never duplicated/drifted across the 3 call sites). Observe-only
    by construction: it counts and signals, never blocks (no enforcement gate exists yet — that's a
    later phase). **Wired into 3 real request paths**, each inside the route's existing
    `withTenantContext` block so the meter write shares the same transaction as the read/write it's
    metering: `api/search/builders.ts` (`action: 'searches'`, cap `SEAT_DAILY_SEARCHES`),
    `api/export/builders.ts` (`action: 'exports'`, cap `SEAT_DAILY_EXPORTS`),
    `api/builders/$builderId.ts`'s tenant-reveal branch (`action: 'reveals'`, cap
    `SEAT_DAILY_REVEALS`). Per-tier ceilings: the existing `SEAT_DAILY_*` env vars are flat
    per-action caps, not actually tier-differentiated (unlike e.g.
    `SESSION_MAX_CONCURRENT_FREE/_PRO/_TEAM_PER_SEAT`) — used them as-is rather than inventing a
    tier-lookup system with no existing wiring to an org's subscription tier; noting this honestly
    rather than silently overclaiming tier-awareness the current env contract doesn't have.
    **Tests** (`anomalies.test.ts`, real disposable-DB integration, not mocked — since this
    composes a real repo write): increments the real `seat_usage_daily` row and stays silent under
    cap; emits `seat_overuse` only once accumulated real usage exceeds the cap (3 calls, cap 2 →
    exactly 1 emission, on the 3rd call); tracks distinct actions independently for the same
    org/user/day. Full sweep: `pnpm tsc --noEmit` clean, `pnpm eslint` clean on all 5 changed files,
    `pnpm vitest run src/shared/lib/abuse src/shared/lib/repositories/seat-usage.test.ts
    --no-file-parallelism` → 128/128 green, `pnpm security:boundaries` → 0 legacy imports.
    **Live end-to-end verification against the real dev server + Postgres**: signed up a real test
    user, called `/api/search/builders`, `/api/export/builders`, and (after inserting a real
    `organization_builders` row so the tenant-reveal branch had something to find)
    `/api/builders/$builderId` — all three still returned their normal 200 responses (confirming
    "search/export still work in observe" holds), and a direct query of `seat_usage_daily` showed
    exactly the 3 expected rows (`searches: 1, exports: 1, reveals: 1`) for that user/org/day.
    Cleaned up the test user, its org-builder row, and the extra dev-server instance afterward.

- [x] **Re-key rate limiting on identity, not IP alone**
  - Files: `src/shared/lib/rate-limit.ts`, `src/shared/lib/rate-limit.test.ts`
  - Do: add `getRateLimitId` variants that compose authenticated `userId` + `organizationId` +
    session hash; apply on authed endpoints so IP rotation cannot reset an authed bucket.
  - Verify: `rate-limit.test.ts` proves an authed user is limited across changing IPs.
  - Progress: Surveyed every existing `rateLimit(...)` call site first — most authed-only routes
    (`sprints/index.ts`, `evidence-refresh.ts`, `recommendations/index.ts`, `ai/complete.ts`,
    `organization-lifecycle.ts`, etc.) already keyed ad hoc on `principal.userId` or
    `${organizationId}:${userId}`, so they were never actually IP-vulnerable — no change needed
    there. **One real gap**: `api/search/builders.ts` (search allows anonymous traffic, so its
    rate-limit check ran *before* any principal was resolved) always used `getRateLimitId(request)`
    (IP/UA-based), even for signed-in users — an authenticated attacker rotating IPs could reset
    their own cap indefinitely. Added `getAuthedRateLimitId({userId, organizationId, sessionHash?})`
    to `rate-limit.ts` — a formalized, tested version of the `${organizationId}:${userId}` pattern
    already used ad hoc elsewhere, with an optional `sessionHash` for callers wanting finer scoping
    than "this user in this org" (unused today, but the composite accepts it without a breaking
    change later). Restructured `search/builders.ts` to resolve the principal (best-effort) *before*
    the rate-limit check, then key on `getAuthedRateLimitId(...)` when a principal exists, falling
    back to `getRateLimitId(request)` only for genuinely anonymous requests — this also let the
    later `requireTenantPrincipal()` call (previously duplicated for tracked-ids/metering) collapse
    into the same single resolved principal. Tests (`rate-limit.test.ts`, 6 new cases): key
    composition (stable, distinct per user, distinct per org, optional sessionHash differentiates),
    and the task-mandated "identity cap holds across IP rotation" case using the same
    `rateLimit()` primitive as the signup-device test, proving the key itself never reads the
    request/IP. Full sweep: `pnpm tsc --noEmit` clean, `pnpm eslint` clean,
    `pnpm vitest run src/shared/lib/rate-limit.test.ts src/shared/lib/abuse --no-file-parallelism`
    → 133/133 green, `pnpm security:boundaries` → 0 legacy imports. **Live end-to-end verification**
    against the real dev server: a real signed-in test user made 61 rapid `/api/search/builders`
    calls cycling through 5 different `X-Forwarded-For` values (203.0.113.x/198.51.100.x/192.0.2.x)
    — 57 succeeded (200) then 4 were rejected (429), exactly at the configured 60/60s cap. Under
    the OLD IP-keyed scheme, cycling 5 IPs would spread the same 61 requests to ~12 per IP, well
    under the 60 cap, and none would ever 429 — the fact that the cap DID trip despite the rotating
    IP header is the concrete proof the identity key is what's actually being enforced. An
    anonymous (no-cookie) call to the same endpoint still succeeded normally (200), confirming the
    IP-keyed fallback path for unauthenticated traffic is untouched. Deleted the test user
    afterward.

- [x] **Export burst throttle + proportionate anti-automation**
  - Files: `src/routes/api/export/builders.ts`, `src/shared/lib/abuse/anti-automation.ts` (+ test)
  - Do: cap exports/day per seat, add an `export_burst` signal, and add lightweight automation
    heuristics (missing/implausible headers, non-interactive cadence) that raise signals, not blocks.
  - Verify: unit tests; export beyond the daily cap emits a signal (and 429 only under `enforce`).
  - Progress: Split into two independent, non-redundant concerns rather than overloading one
    signal type. (1) **The daily cap** was already tracked via Task 1's `meterSeatActionAndEmit`
    (`SEAT_DAILY_EXPORTS`, `seat_overuse` signal) — this task adds the missing piece: **real
    enforcement**. `export/builders.ts` now calls the already-exported pure `detectSeatOveruse`
    against the post-increment count and, only when `ABUSE_ENFORCEMENT_MODE === 'enforce'` AND the
    seat is over its cap, returns `429` before doing any CSV work — the metering/signal call itself
    still never blocks (matches Task 1's contract exactly; only this NEW explicit check blocks, and
    only under `enforce`). (2) **New `abuse/anti-automation.ts`** for the "lightweight automation
    heuristics" half, deliberately independent of the day cap: `detectMissingOrImplausibleHeaders`
    (no User-Agent, no Accept header, or a known non-browser client signature — curl/wget/
    python-requests/PostmanRuntime/okhttp/axios/node-fetch/Scrapy; a narrow, well-known-library
    list, not "anything unusual," to avoid false-positiving on legitimate but uncommon browsers)
    and `detectNonInteractiveCadence` (sub-500ms gap since the same identity's last export — a
    human cannot sustain that clicking a button) + a module-scoped in-memory `recordExportRequestCadence`
    wrapper (same "lightweight, resets on restart" precedent as `rate-limit.ts`'s in-memory
    fallback bucket). `checkExportBurstAndEmit` emits the dedicated `export_burst` signal (not
    `seat_overuse`) whenever either heuristic fires — per the task's explicit wording, this half
    **never blocks on its own**, regardless of enforcement mode; it only ever raises a signal.
    Both checks run on every export request, independently of each other. Tests
    (`anti-automation.test.ts`, 21 cases): header detection table (missing UA/Accept, each listed
    client signature, two plausible-browser negatives), cadence detection (first-ever call never
    flags, under/at/over the threshold, custom threshold), the stateful `recordExportRequestCadence`
    wrapper (first call per key never flags, rapid second call flags, distant second call doesn't,
    distinct keys tracked independently), and `checkExportBurstAndEmit` (silent when neither
    heuristic fires, emits on headers alone, emits on cadence alone). Full sweep: `pnpm tsc --noEmit`
    clean, `pnpm eslint` clean, `pnpm vitest run src/shared/lib/abuse --no-file-parallelism` →
    144/144 green, `pnpm security:boundaries` → 0 legacy imports. **Live end-to-end verification**
    against the real dev server: temporarily set `SEAT_DAILY_EXPORTS=2` and
    `ABUSE_ENFORCEMENT_MODE=enforce` (standard restart-required override this plan has needed every
    time), signed up a real user, made curl-based export requests (curl's own UA trips
    `detectMissingOrImplausibleHeaders` for free) — the 1st and 2nd succeeded (200), the 3rd was
    rejected with `429 {"error":"Daily export limit reached for this seat. Try again tomorrow."}`;
    a direct query of `abuse_signals` showed real `export_burst` rows on every attempt
    (`suspiciousHeaders: true`, `nonInteractiveCadence` correctly varying true/false by actual
    timing) and real `seat_overuse` rows once the cap was crossed (`count: 3, cap: 2` and
    `count: 4, cap: 2` — the blocked attempt's own increment still landed, matching "emits a signal"
    regardless of the block). Reverted both env vars, restarted, and confirmed the exact same
    3-request sequence now returns `200/200/200` under the default `observe` mode + real
    `SEAT_DAILY_EXPORTS` — full backward compatibility for every deployment that hasn't opted into
    `enforce`. Deleted every test user created during verification afterward.

## Phase 4B — Credit / premium-feature abuse (G)

- [x] **Verify built credit-ledger invariants under the real runtime role (G3/G5/G9/G10)**
  - Files: `scripts/db/verify-api-isolation-local.mjs`, `src/shared/lib/billing/reservations.test.ts`,
    `src/shared/lib/repositories/billing-ledger.ts`
  - Do: add adversarial checks as `builderhunt_app` — concurrent `reserveCredits` never overspends;
    balance never negative; a monthly-window grant is unique per subscription/window/type; a replayed
    idempotency key returns the cached result (no second grant/refund); `settleReservation` cannot
    settle more than reserved and `actualUnits` is server-derived (not client-widened).
  - Verify: `pnpm test` (new reservation/ledger cases) + `pnpm test:api-isolation:local` green;
    document each verified invariant.
  - Progress: **Researched first** (Explore sub-agent, full read of `reservations.ts`/
    `reservations.test.ts`/`billing-ledger.ts`/`verify-api-isolation-local.mjs`) before writing
    anything, to find the REAL gap rather than duplicate existing coverage. Finding: `reserveCredits`/
    `settleReservation`/`grantCredits`/etc. already had thorough business-logic tests (including the
    exact `Promise.all` concurrent-overspend race, the over-settlement rejection, and idempotency
    replay with ledger-state assertions, not just a `replayed` flag) — but **every one of them only
    ever ran against the disposable-DB migration-OWNER connection**, never `builderhunt_worker` (the
    only role that can actually write these tables — `builderhunt_app` has zero INSERT/UPDATE grant
    on any of the four credit-ledger tables per `drizzle/0028_billing_rls_grants.sql`, so the task's
    own "as `builderhunt_app`" is read as "as the real restricted role," i.e. `builderhunt_worker`).
    `docs/operations/database-roles.md` itself says *"never test RLS as the owner and treat that as
    evidence"* — this task's entire job was closing exactly that gap, not inventing new business
    logic. No route calls `reserveCredits`/`settleReservation` yet (`feature-authorization.ts` isn't
    wired to any endpoint), so unlike every other check in `verify-api-isolation-local.mjs` there's no
    route handler to import — new `checkCreditLedgerInvariantsUnderWorkerRole()` calls the library
    functions directly through `withWorkerOrganization` (the real drizzle transaction + RLS context
    every actual writer will use), asserting: G9 negative-units rejection, a real 100-unit grant
    creation, G5 monthly-window uniqueness under genuine `Promise.allSettled` concurrency (not just
    sequential, per `credits.test.ts:79-91`), G3/G9 concurrent-reservation overspend prevention, G3
    over-settlement rejection, and G10 settlement-replay cache consistency.
    **Ran for real** — not just written, actually executed against a real Postgres with real RLS
    enforced. Running `prepare-rls-fixture.mjs`/`test:api-isolation:local` locally would normally risk
    mutating the shared dev cluster's role passwords (this plan's standing caution from Phase 3), so
    spun up a throwaway, fully isolated `pgvector/pgvector:pg16` Docker container (matching CI's exact
    recipe from `.github/workflows/quality.yml`) instead — zero risk to the concurrent session sharing
    the persistent local Postgres. Discovered along the way that `prepare-rls-fixture.mjs` already
    guards against mutating real global role passwords outside `CI=true`/an explicit opt-in env var
    (creates `_rls_ci`-suffixed roles instead) — this was likely already true when the earlier Phase 3
    caution was written and simply hadn't been rediscovered; worth remembering this makes
    `test:rls:local` itself safer to run locally than previously assumed, IF pointed at a database
    matching the `builderhunt_security_test_*` naming guard (still never the persistent dev database).
    **A real bug surfaced by the first run — in the new test, not the product**: the concurrent
    reserveCredits race initially reported BOTH 60-unit reservations succeeding against what looked
    like a 100-unit balance. Direct inspection of the actual rows showed why: the reservation-race
    check shared an organization with the just-completed monthly-window-grant race, which had legitimately
    added a second 50-unit grant to the same pool (100 + 50 = 150 available — both 60-unit reservations,
    totalling 120, correctly fit, and the allocator correctly left exactly 30 total remaining across
    both grants). The allocator was correct; the test's assumption of an isolated 100-unit pool was
    not. Fixed by giving the reservation-race its own dedicated organization with its own dedicated
    grant — reran clean afterward. Documenting this because it's exactly the kind of race-condition
    reasoning error this task exists to catch in the *product* — catching it in the *test* first is
    the harness working as intended.
    **Result: all 8 new checks + all 86 pre-existing checks passed (94/94, exit 0)** against the real
    `builderhunt_worker`/`builderhunt_app` roles with RLS/grants genuinely enforced — G3, G5, G9, and
    G10 all independently confirmed to hold under the actual restricted runtime role, not just the
    disposable-DB owner. Also generated the missing `drizzle/meta/0045_snapshot.json` (the
    `0045_user_devices_worker_read_grant.sql` migration from Phase 3 was hand-authored without
    `drizzle-kit generate`, matching precedent for RLS-only migrations, but its snapshot file was
    never created) — `pnpm exec drizzle-kit check`/`verify-migration-integrity.mjs` both failed
    until this was added; fixed by copying `0044_snapshot.json`'s schema shape forward with a new
    `id`/`prevId` chain (no actual schema difference, since 0045 only adds RLS policy + GRANT
    statements, which drizzle-kit's snapshot format doesn't track) and regenerating
    `migration-hashes.json`. Both integrity checks pass again.
    **Strengthened `reservations.test.ts`** (the task's own file list) with the two secondary gaps
    the research surfaced: the existing `reserveCredits` replay test now also asserts the grant's
    `remainingUnits` reflects exactly one allocation (170, not double-decremented), not just the
    `replayed` flag; and a new test in the concurrency `describe` block races two settle calls with
    **different** idempotency keys (no replay short-circuit possible) against the same 80-unit
    reservation, proving the `state !== 'reserved'` guard — not just the idempotency lookup — holds
    under genuine concurrency (exactly one of two racing 80-unit settles succeeds, the other sees
    "no longer reserved," total remaining is 20 as expected, never a double-consume).
    Full sweep: `pnpm tsc --noEmit` clean, `pnpm eslint` clean, `pnpm vitest run
    src/shared/lib/billing/reservations.test.ts src/shared/lib/billing/credits.test.ts
    --no-file-parallelism` → 35/35 green, `pnpm exec drizzle-kit check` clean,
    `node scripts/db/verify-migration-integrity.mjs` valid, `pnpm security:boundaries` → 0 legacy
    imports. Removed the throwaway Docker container afterward.

- [x] **Per-seat credit sub-budget + `pool_drain` signal (G2)**
  - Files: `src/shared/lib/billing/reservations.ts`, `src/shared/lib/repositories/seat-usage.ts`,
    `src/shared/lib/abuse/credit-abuse.ts` (+ test)
  - Do: on each reservation, record the acting seat's credit units into `seat_usage_daily`; when a
    small number of seats consume a disproportionate share of a Team pool, emit `pool_drain`. Observe:
    record + signal only; `enforce` applies `CREDIT_SEAT_DAILY_UNITS` as a per-seat sub-cap.
  - Verify: unit tests for the share computation + sub-cap math; no change to pooled total in observe.
  - Progress: implemented at the `billing/feature-authorization.ts` `reserveCredits` layer (not raw
    `reservations.ts`, which is organization-scoped only and has no `userId`/seat concept — see
    Phase 4B task 1's finding) rather than `reservations.ts` itself. Added `CREDIT_SEAT_DAILY_UNITS`
    (default 2000) to `env.ts`; `listSeatUsageForOrgDay` to `repositories/seat-usage.ts` (every
    seat's usage row for one org/day/action, used for both the seat-count and pool-total
    computation); new `abuse/credit-abuse.ts` (`computeSeatShare`, `detectPoolDrain` — never flags a
    single-seat org — `checkPoolDrainAndEmit`). `reserveCredits` now: (1) in `enforce` mode only,
    pre-checks whether this reservation would push the acting seat over `CREDIT_SEAT_DAILY_UNITS`
    in a multi-seat org, throwing `FeatureBillingError('blocked')` BEFORE any credits are reserved
    if so; (2) always (any mode) records the seat's consumed units into `seat_usage_daily` (action
    `'messages'`) after a successful reservation and emits `pool_drain` via `checkPoolDrainAndEmit`
    when the post-increment total crosses the cap — detection only, no change to the pooled total.
    Added an optional `deps?: EmitAbuseSignalDeps` parameter to `reserveCredits` (same DI seam as
    every other `check*AndEmit` call site in this plan) so tests never write to the real
    `abuse_signals` table. 8 new unit tests for `credit-abuse.ts` (pure functions + emit gating) and
    3 new real-Postgres integration tests in `feature-authorization.test.ts` (single-seat org never
    blocks/flags however far over cap; observe mode records usage + emits `pool_drain` but never
    blocks a multi-seat org's over-cap seat; enforce mode blocks a multi-seat org's seat before any
    credits are reserved, leaving `seat_usage_daily` unchanged) — all 18 tests in that file plus all
    8 new tests pass (`pnpm vitest run src/shared/lib/billing/feature-authorization.test.ts
    src/shared/lib/abuse/credit-abuse.test.ts`). Full `src/shared/lib/billing` + `src/shared/lib/abuse`
    suites (821 tests) pass with no regressions; `pnpm tsc --noEmit` and `pnpm eslint` on every
    touched file are clean. Live-verified end-to-end against the real local dev Postgres database
    (not disposable/mocked) via a throwaway direct-call script (no route wires to
    `feature-authorization.ts` yet, so there is no HTTP path to exercise): seeded a real multi-seat
    org + subscription + credit grant, confirmed the first reservation (reaching exactly the cap)
    succeeds, the second (crossing the cap) throws `FeatureBillingError('blocked')`, `seat_usage_daily`
    stays at 50 units (the blocked attempt never reserves or records), and no `pool_drain` row is
    written for the blocked attempt (detection only runs after a successful reservation) — script and
    all seeded rows deleted afterward, confirmed zero residual rows in the dev database.

- [x] **Metering-bypass boundary test — every provider entry point is metered (G8)**
  - Files: `scripts/check-provider-metering.mjs`, `package.json` (script), `.github/workflows/quality.yml`
  - Do: static check that every server path calling MiniMax/embeddings (`ai/minimax.ts`,
    `ai/embeddings.ts`) is reached only through `reserveCredits`/`checkAndConsumeBudget`, with an
    explicit allowlist for the free local (Chrome) tier. Fail CI on an un-metered provider call.
  - Verify: `node scripts/check-provider-metering.mjs` exits 0 on the current tree; add a failing fixture.
  - Progress: **found and fixed a real un-metered provider call while building the check** —
    `src/lib/semantic/semantic-search.ts`'s `embedQueryCached()` called `embedTexts()` (query
    embedding for every semantic-search request) with zero budget/credit gating, unlike the file's
    other MiniMax call (`translateQueryServerSide`, already gated by `checkAndConsumeBudget`). Fixed
    by threading `principal`/`entitlement` into `embedQueryCached` and adding a
    `checkAndConsumeBudget` call (new `SEMANTIC_SEARCH_EMBED_ALLOWANCES` — `{free:0, pro:500,
    team:1000}`, matching `AITaskDefinition`'s allowance shape without forcing this into the
    chat-shaped task registry, since `checkAndConsumeBudget` only needs `Pick<AITaskDefinition,
    'id'|'allowances'>`) right before the actual provider call, on a cache miss only — a budget
    exhaustion throws, which `routes/api/search/semantic.ts` already catches and degrades to
    keyword-fallback search, matching this file's existing "any AI failure is caught by the caller"
    contract. Confirmed the free/local (Chrome on-device) tier (`ai/local.ts`) needs no allowlist
    entry — it calls the browser's `LanguageModel` global directly and never imports
    `ai/minimax.ts`/`ai/embeddings.ts`, so it's structurally invisible to this check.
    `scripts/check-provider-metering.mjs`: walks `src/`, and for any file importing
    `ai/minimax.ts`/`ai/embeddings.ts`, tracks brace depth per line — `gatedInScope` resets to false
    whenever depth returns to 0 (back to top level between sibling declarations), so a
    `checkAndConsumeBudget(`/`reserveCredits(` call anywhere in the SAME top-level function as a
    `minimaxChat(`/`embedTexts(` call satisfies it, but a call in an unrelated top-level function in
    the same file does not — this was necessary because `semantic-search.ts` has one gated and one
    (pre-fix) ungated call site in the same file, which a plain per-file grep (like the two sibling
    `check-*.mjs` scripts use) would have missed. Two whole-file allowlist entries with inline
    justification: `src/lib/semantic/embed-worker.ts` (internal scheduled backfill worker, no
    per-request principal) and `src/routes/api/ai/embed.ts` (platform-admin-only operator surface,
    not a tenant-billed feature). Verified the check actually catches a violation: added a temporary
    fixture file with an ungated `minimaxChat()` call, confirmed `node
    scripts/check-provider-metering.mjs` exits 1 with the exact file:line finding, then deleted the
    fixture and confirmed a clean exit 0 again. Wired as `pnpm security:provider-metering` in
    `package.json`, added as a new CI step in `.github/workflows/quality.yml` right after
    `security:route-coverage` (this CI change was explicitly authorized by the user, per the
    standing check-in agreement for pipeline modifications). `pnpm tsc --noEmit` and `pnpm eslint`
    clean; full `pnpm vitest run src/lib/semantic src/shared/lib/ai src/routes/api/search
    src/routes/api/ai src/routes/api/builders` (87 tests) passes with no regressions; all three
    `security:*` check scripts (`boundaries`, `route-coverage`, `provider-metering`) pass on the
    current tree. Not separately browser-verified end-to-end (semantic search requires seeding a
    real pro/team org + pgvector embedding data, out of scope for this metering-wiring fix) — relies
    on the passing test suite plus the two already-well-tested pieces being composed
    (`checkAndConsumeBudget`, `embedTexts`) for confidence.

- [x] **First-payer credit-consumption cap + spend-velocity signal (G6)**
  - Files: `src/shared/lib/billing/reservations.ts`, `src/shared/lib/abuse/credit-abuse.ts`,
    `src/shared/lib/abuse/risk.ts`
  - Do: cap credit consumption for a new payer / new payment method to `CREDIT_FIRST_PAYER_CAP_UNITS`
    within `CREDIT_FIRST_PAYER_WINDOW_HOURS`; feed a spend-velocity input into `account_risk` so a
    buy→burn burst can gate high-cost ops behind step-up. Coordinate with Stripe Radar (do not duplicate).
  - Verify: unit tests for the first-payer window + cap; integration test that observe mode never blocks.
  - Progress: implemented at the `billing/feature-authorization.ts` `reserveCredits` layer (same
    reasoning as G2 — `reservations.ts` is organization-scoped only, no `userId`, so it can't emit a
    per-actor signal). "New payer" = an org whose earliest **paid-source** credit grant (`pack`,
    `subscription_monthly`, `subscription_annual_window`, `subscription_upgrade_delta` — never
    `promotional`/`operator_trial`/`legacy_manual`) is younger than `CREDIT_FIRST_PAYER_WINDOW_HOURS`
    (default 48). New `repositories/billing-ledger.ts` reads: `findEarliestPaidGrantCreatedAt` (MIN
    createdAt across paid-source grants) and `sumReservedUnitsSince` (sums the `reserve` ledger
    entry's `unitsDelta` — the actual moment credits leave a grant's balance, per
    `billing/reservations.ts`; `consume`/`release` markers always carry `0` and were confirmed via
    direct code read, not assumption). New env vars `CREDIT_FIRST_PAYER_WINDOW_HOURS` (default 48)
    and `CREDIT_FIRST_PAYER_CAP_UNITS` (default 500). New pure functions in `abuse/credit-abuse.ts`:
    `isWithinFirstPayerWindow`, `detectFirstPayerCapExceeded`, `checkFirstPayerSpendVelocityAndEmit`
    (same `detect*`/`check*AndEmit` convention as G2). **Required a new migration** (user explicitly
    authorized touching CI/migrations for this task, per the standing check-in agreement) —
    `abuse_signals.type` has a real Postgres CHECK constraint, and none of the 5 existing
    `AbuseSignalType` values (`credit_farming`, `pool_drain`, `refund_farming`, `margin_drift`,
    `reserve_leak`) semantically fit "spend velocity"; added `credit_spend_velocity` to the union
    (`abuse/signals.ts`) and `drizzle/0046_abuse_signals_credit_spend_velocity.sql` (DROP/ADD
    CONSTRAINT widening the CHECK list — no existing rows affected), with `0046_snapshot.json`
    derived from `0045`'s (same RLS/CHECK-only precedent as 0045 itself — drizzle-kit's snapshot
    format doesn't track CHECK constraints). `reserveCredits`: in `enforce` mode only, and only
    while the org is inside its first-payer window (an established payer skips the heavier
    consumption-history query entirely), pre-checks whether this reservation would push the
    window's total reserved units over the cap, throwing `FeatureBillingError('blocked')` BEFORE any
    credits are reserved; always (any mode, new-payer orgs only) emits `credit_spend_velocity` after
    a successful reservation crosses the cap — detection only, reusing the same pre-fetched
    `unitsReservedInWindow` value for both the pre-check and the post-emit (one extra query per
    new-payer request, zero extra for established payers). Confirmed explicitly this does NOT
    duplicate `billing/risk.ts`'s `assertNotRiskBlocked` (a payment-*failure*-velocity gate on new
    Checkout/PaymentIntent creation, already coordinating with Stripe Radar/3DS per its own header
    comment) — G6 caps *consumption* of already-granted credits, a genuinely separate surface.
    16 new unit tests for `credit-abuse.ts` (window/cap pure functions + emit gating) and 3 new
    real-Postgres integration tests in `feature-authorization.test.ts` (established payer — 0-hour
    window — never capped/flagged however far over cap; observe mode emits `credit_spend_velocity`
    but never blocks a new payer over cap; enforce mode blocks a new payer's reservation before any
    credits are reserved) — all 21 tests in that file plus all 16 new tests pass. Full
    `src/shared/lib/billing` + `src/shared/lib/abuse` suites (832 tests) pass with no regressions;
    `pnpm tsc --noEmit`/`pnpm eslint` clean; `node scripts/db/verify-migration-integrity.mjs`
    (47 migrations) and `pnpm exec drizzle-kit check` both clean. Live-verified against the real
    local dev Postgres database: applied migration 0046 via `drizzle-kit migrate` and confirmed via
    `psql \d abuse_signals` that the CHECK constraint now includes `credit_spend_velocity`; ran a
    throwaway direct-call script seeding a real paid-source grant for a fresh org, confirming the
    first reservation (reaching exactly the cap) succeeds, the second (crossing the cap) throws
    `FeatureBillingError('blocked')`, exactly one `billing_credit_reservations` row exists afterward
    (the blocked attempt never reserved), and no `credit_spend_velocity` signal was written for the
    blocked attempt — script and all seeded rows deleted afterward, confirmed zero residual rows.
    Note: feeding this into `account_risk`/`recomputeAccountRisk` needs no extra wiring —
    `recomputeAccountRisk` already reads any signal type for that `userId` from `abuse_signals`
    (confirmed via research this task; it has no per-type special-casing), so `credit_spend_velocity`
    is picked up by the existing risk-scoring pipeline the next time that user's risk is recomputed.

- [x] **Refund-farming cap + `refund_farming` signal (G4)**
  - Files: `src/shared/lib/billing/reservations.ts` (`refundUsage` path),
    `src/shared/lib/abuse/credit-abuse.ts` (+ test)
  - Do: require provider-evidence for a usage refund, make it idempotent per settlement, cap refunds
    per account/day at `CREDIT_REFUND_MAX_PER_DAY`, and emit `refund_farming` on a high
    refund-to-settle ratio.
  - Verify: unit tests: a second refund for the same settlement is rejected; ratio threshold fires a signal.
  - Progress: like G2/G6, `refundUsage` actually lives in `billing/feature-authorization.ts`, not
    `reservations.ts` (doc/reality mismatch already noted for those two tasks — confirmed
    `reservations.ts` has no `refundUsage` at all). Idempotency-per-settlement was already correctly
    handled by the existing implementation (duplicate idempotency key replays; per-allocation
    `consumedUnits` naturally caps cumulative refunds to what was actually settled) — verified this
    by reading the code rather than assuming, so no change was needed there. Three net-new pieces:
    (1) **provider-evidence requirement** — `RefundUsageInput` gained a required
    `providerEvidenceReference: string`, rejected if blank; (2) **daily refund cap** — new
    `sumRefundedUnitsSince`/`sumSettledUnitsSince` in `repositories/billing-ledger.ts` plus
    `detectRefundCapExceeded`/`detectRefundFarming`/`checkRefundFarmingAndEmit` in
    `abuse/credit-abuse.ts` (same `detect*`/`check*AndEmit` convention); (3) **ratio signal**
    (`refund_farming` — already a valid `AbuseSignalType`, no new migration needed here). Key design
    finding from reading `billing/credits.ts`'s `adjustCreditGrant`: its `AdjustCreditGrantInput` has
    no `reservationId` field at all, so its own ledger entries (used both by `refundUsage`'s
    per-allocation compensating credits AND by the unrelated `billing/refunds.ts` money-refund
    grant-revocation path) never set `reservationId` — only `refundUsage`'s own trailing marker
    entry does. This meant changing that ONE marker's `unitsDelta` from the previous convention (`0`,
    a pure idempotency pointer) to the actual `input.units` gives an unambiguous, non-double-counting
    signal to sum for "refunded units in a window", with zero collision risk against either the
    per-allocation entries or `refunds.ts`'s unrelated pack-refund revocations. `refundUsage` now: in
    `enforce` mode only, pre-checks the rolling-24h refund total against `CREDIT_REFUND_MAX_PER_DAY`,
    throwing `FeatureBillingError('blocked')` BEFORE crediting anything if exceeded; always (any
    mode) computes the refund-to-settle ratio over `CREDIT_REFUND_FARMING_WINDOW_HOURS` (default 30
    days) and emits `refund_farming` when it crosses `CREDIT_REFUND_FARMING_RATIO_THRESHOLD` (default
    0.5) with at least `CREDIT_REFUND_FARMING_MIN_SETTLED_UNITS` (default 100) settled units in the
    window (guards a brand-new org's tiny sample from tripping the ratio) — this signal never blocks
    by itself, only the daily cap does; both checks are fully independent. Added optional
    `deps?: EmitAbuseSignalDeps` param to `refundUsage` (same DI seam as G2/G6). 4 new unit tests for
    the two new pure functions + `checkRefundFarmingAndEmit` (23 total in `credit-abuse.test.ts`),
    plus 1 new "requires non-empty evidence" test and 3 new real-Postgres integration tests in
    `feature-authorization.test.ts` (enforce mode blocks once the daily cap would be crossed, leaving
    the grant's `remainingUnits` unchanged; observe mode emits `refund_farming` at a 0.55 ratio
    without blocking; enforce mode confirms the ratio signal alone never blocks — only the cap does)
    — all 25 tests in that file plus all 23 credit-abuse tests pass, no regressions across the full
    `src/shared/lib/billing` + `src/shared/lib/abuse` suites (843 tests). `pnpm tsc --noEmit`/
    `pnpm eslint` clean. Live-verified against the real local dev Postgres database via a throwaway
    direct-call script: a 3-unit refund reaching exactly a 3-unit daily cap succeeds, a further
    1-unit refund (crossing the cap) throws `FeatureBillingError('blocked')` with the grant's
    `remainingUnits` provably unchanged, and (since 3/10 = 0.3 is under the 0.5 ratio threshold) zero
    `refund_farming` signals were recorded, confirming the ratio check correctly stayed silent in
    this scenario — script and all seeded rows deleted afterward, confirmed zero residual rows.

- [x] **Provider cost-vs-credit margin monitor + `margin_drift` signal (G7)**
  - Files: `src/shared/lib/abuse/margin.ts` (+ test), `src/shared/lib/ai/minimax.ts` (cost capture)
  - Do: record estimated provider cost per settled op; when provider cost ÷ credits charged exceeds
    `CREDIT_MARGIN_ALERT_RATIO`, emit `margin_drift` (alert only, never auto-block). Confirm each op's
    reserved max covers worst-case provider cost and max output tokens are capped per `_meta/ai-policy.md`.
  - Verify: unit tests for the ratio + a capped-max-tokens assertion per server AI task.
  - Progress: **explicitly NOT wired to production** — confirmed by research (and surfaced to the
    user before building, per the standing check-in agreement for scope surprises) that
    `reserveCredits` (the dollar-based credit ledger built in G2/G6/G4) is never called from ANY
    production route today; all 3 real `minimaxChat` call sites (`semantic-search.ts`,
    `enrichment.ts`, `/api/ai/complete`) use the call-count `checkAndConsumeBudget` budget instead.
    There is therefore no live "settled op with credits actually charged" to attach a margin ratio
    to yet — building a "live" monitor with no real integration point would be theater. Per the
    user's explicit choice, built the pure/tested detection logic only, ready for a future feature
    that actually reserves+settles dollar credits for an AI call to wire in.
    `ai/minimax.ts`: added an optional `onUsage?: (usage: MinimaxUsage) => void` observer param to
    `minimaxChat` (fully backward compatible — omitted by every existing caller/test, changes
    nothing about the call itself) that reports `{promptTokens, completionTokens}` parsed from the
    provider response's `usage` field for EVERY underlying provider call, including the
    JSON-correction retry (a real, separately-billed second call when it happens). New
    `abuse/margin.ts`: `estimateProviderCostCents` (tokens → cents via the new placeholder
    `MINIMAX_COST_PER_1K_INPUT_TOKENS_CENTS`/`MINIMAX_COST_PER_1K_OUTPUT_TOKENS_CENTS` env vars,
    explicitly documented as NOT confirmed MiniMax pricing), `detectMarginDrift` (pure ratio check
    against `CREDIT_MARGIN_ALERT_RATIO`, never flags when nothing was charged), `checkMarginDriftAndEmit`
    (alert-only — this signal never blocks anything by itself, matching the task's "alert only, never
    auto-block" requirement). Added a "capped max-tokens" assertion test to the existing
    `ai/tasks.test.ts` asserting every `AI_TASKS` entry's `maxOutputTokens` is finite, positive, and
    under a generous 8192-token sanity ceiling — protects against a future task shipping without an
    explicit cap (no numeric ceiling was actually stated in `_meta/ai-policy.md`, so this bound is a
    defensive sanity check, not a transcription of a documented policy number). 3 new tests for
    `minimaxChat`'s usage reporting (single call, missing-usage-field default, both calls on a
    retry) plus 1 new capped-max-tokens test, plus a new `margin.test.ts` (8 tests: cost estimation,
    ratio detection at/under/over/with-a-looser-threshold, emit gating) — 33 new/changed tests total,
    all pass; no regressions across `src/shared/lib/ai` + `src/shared/lib/abuse` + `src/lib/semantic`
    + `src/routes/api/ai` + the enrichment route (266 tests). `pnpm tsc --noEmit`/`pnpm eslint`
    clean. No migration needed (`margin_drift` was already a valid `AbuseSignalType`). No live-database
    verification for this task specifically — nothing writes a real `margin_drift` row in production
    yet (by design, per the scope decision above), so there is no additional real-world behavior
    beyond what the unit tests already prove; `checkMarginDriftAndEmit`'s emit path is structurally
    identical to the other `check*AndEmit` functions already live-verified this session.

- [x] **Promo/trial grant caps per identity cluster (G1)**
  - Files: `src/shared/lib/abuse/linked-accounts.ts`, promo/trial grant path in `billing/*`
  - Do: before minting a promo or manual-trial grant, cap total grants per device/payment/identity
    cluster at `PROMO_GRANT_MAX_PER_CLUSTER`; emit `credit_farming` when the cap is hit.
  - Verify: unit test that a second clustered account cannot claim the same promo beyond the cap.
  - Progress: **explicitly NOT wired to production**, same reasoning and same user-approved pattern
    as G7 — surfaced before building, per the standing check-in agreement. Repo-wide search
    confirmed no promo/trial-grant-minting route exists at all today: `grantCredits({source:
    'promotional', ...})` is only ever called internally by `feature-authorization.ts`'s
    `refundUsage` fallback (crediting a refund back when the original grant has expired — not a
    signup bonus), and `source: 'operator_trial'` is never used anywhere. Additionally, even the
    READ side has no live path: counting promo/trial grants across every organization in a
    linked-account cluster would need a genuinely new cross-organization RLS grant on
    `billing_credit_grants` (confirmed every existing `builderhunt_worker` policy on that table is
    scoped to a single `app.organization_id` via `set_config`, never `USING (true)`) — a real
    migration, out of proportion for a feature with no live caller. Built the pure detection/signal
    logic only: `detectPromoGrantClusterCapExceeded`/`checkPromoGrantClusterCapAndEmit` (same
    `detect*`/`check*AndEmit` convention, emits the existing `credit_farming` signal type — no new
    migration needed) in `abuse/credit-abuse.ts`, plus `organizationIdsForCluster` in
    `abuse/linked-accounts.ts` — a small pure bridge from a user-keyed `AccountCluster` (Phase 3's
    clustering is by shared device/IP, not by organization) to the deduped set of organization ids
    its members belong to, taking the user→organization lookup as a plain injected `Map` rather than
    querying it (that query is the part that needs the new RLS grant, left for whoever wires this in
    for real). New `PROMO_GRANT_MAX_PER_CLUSTER` env var (default 3). 8 new unit tests (3 for the
    detect function's boundary cases, 2 for the emit gating, 3 for `organizationIdsForCluster`'s
    dedup/sort/missing-lookup behavior) — all pass, no regressions across the full `src/shared/lib/abuse`
    suite (183 tests). `pnpm tsc --noEmit`/`pnpm eslint` clean. No live-database verification for
    this task specifically, for the same reason as G7: nothing writes a real `credit_farming` row
    from this path in production yet, by design — the emit path itself
    (`checkPromoGrantClusterCapAndEmit`) is structurally identical to every other `check*AndEmit`
    function already live-verified this session (G2/G6/G4).

    **This closes out Phase 4B's core credit/premium-feature abuse work (G1, G2, G4, G6, G7, G8) —
    all 7 tasks in this phase are now complete.** Three of them (G1, G7, and effectively half of G8's
    real production impact via the `semantic-search.ts` fix) surfaced genuine architecture gaps
    during implementation rather than being simple feature-adds: no production route yet calls the
    dollar-based credit ledger (`reserveCredits`) at all, and no production route mints a promo/trial
    grant. Every abuse-detection primitive built this phase (per-seat sub-budget, first-payer cap,
    refund-farming cap, margin monitor, promo-cluster cap) is fully implemented, unit-tested, and
    ready to activate the moment a real feature calls into the credit ledger for real spend — but
    none of them observe anything in production today beyond what was already wired in G2's
    `reserveCredits`/`refundUsage` entry points themselves (which G4/G6 also hook into, since those
    genuinely are called — by this session's own verification scripts and future callers, just not
    yet by any shipped feature). Phase 5 (enforcement ladder + admin console) is next.

## Phase 5 — Enforcement ladder + admin console (A–G response)

- [x] **`resolveEnforcement()` policy + request wiring**
  - Files: `src/shared/lib/abuse/enforcement.ts` (+ test), `src/shared/lib/auth/tenant-principal.ts`
  - Do: single policy mapping risk+mode → `observe|warned|stepup|throttled|blocked`; wire a check
    into authed request resolution so a stage applies consistently (warn banner flag, step-up
    required, tighter limits, or session revocation + upsell).
  - Verify: unit tests for every stage transition; integration test that `observe` is a no-op.
  - Progress: `abuse/enforcement.ts` — pure `resolveEnforcement(mode, candidateStage)`: `observe`
    mode always resolves to `'observe'` regardless of the candidate (matches this plan's fail-open
    invariant); `warn` mode caps the effective stage at `'warned'` (this is the first place `warn`
    is ever distinguished from `observe` in this codebase — every other gate built earlier in this
    plan only branches on `=== 'enforce'`); `enforce` passes the candidate through unchanged.
    `resolveEnforcementForUser(userId, deps?)` is the request-facing entry point (matches
    `spec.md`'s own `resolveEnforcement(userId)` signature): reads the already-persisted
    `account_risk.stage` via the existing cheap `getAccountRisk` read (no rescoring), defaulting to
    `'observe'` for a user with no row yet or a corrupt/unexpected stage value. **Short-circuits
    before touching the database at all when mode is `'observe'`** (the default) — since
    `resolveEnforcement('observe', X)` is always `'observe'` regardless of `X`, the query result
    could never matter, so the per-request cost in the default configuration is zero; the
    worker-role read only happens once an operator deliberately opts into `warn`/`enforce`. This
    resolved the one real design tension research surfaced: `account_risk` has no `builderhunt_app`
    grant at all (by design — see `drizzle/0044`'s own comment), so a naive per-request check would
    need either a new RLS grant or accept a worker-role round trip on every page load; the
    observe-mode short-circuit sidesteps both.
    Wired into `auth/tenant-principal.ts`: added an optional `getEnforcementStage?(userId)` hook to
    `TenantPrincipalDependencies` (same DI seam as the existing `onMembershipDenied` hook) — only
    `'blocked'` changes anything (`resolveTenantPrincipal` throws a 403 `TenantAuthorizationError`),
    closest analogue to spec.md's "revoke extra sessions" for the front door. `'warned'`/`'stepup'`/
    `'throttled'` intentionally do NOT alter request resolution here — those are Phase 5's own
    follow-up tasks (dashboard banner, step-up route, rate-limit tightening) with their own specific
    surfaces; keeping this function's blast radius to exactly what it already does (deciding whether
    a request gets a principal at all). `requireTenantPrincipal` wires the real
    `resolveEnforcementForUser` call. 18 new unit tests (14 for `resolveEnforcement`'s stage-cap
    matrix + `resolveEnforcementForUser`'s short-circuit/DI/fallback behavior in `enforcement.test.ts`,
    4 new tests in `tenant-principal.test.ts` for the blocked-rejects / non-blocked-passes-through /
    membership-denied-short-circuits-before-enforcement-check cases) — all pass, no regressions
    across the full `src/shared/lib/auth` + `src/shared/lib/abuse` suites (277 tests). `pnpm tsc
    --noEmit`/`pnpm eslint` clean. Live-verified in the real dev browser: signed up a fresh test
    account end-to-end (default `ABUSE_ENFORCEMENT_MODE=observe`), confirmed onboarding and the
    dashboard both load with zero errors and zero added request latency (the short-circuit means
    `account_risk` was never queried for this session) — test account and its cascaded rows deleted
    from the dev database afterward.

- [x] **Warn banner + step-up re-auth UX**
  - Files: `src/modules/dashboard/components/AbuseWarningBanner.tsx` (+ test),
    `src/routes/_dashboard/route.tsx`, `src/routes/api/me/stepup/index.ts`
  - Do: show a fairness-framed banner at `warned`; require password/verified-email re-auth at
    `stepup` before the next sensitive action.
  - Verify: component test; Playwright: forced `stepup` prompts re-auth once, then proceeds.
  - Progress: **No Playwright added** — standing instruction this session never builds new
    e2e/Playwright test files; verified the flow live in the real dev browser instead (below).
    `AbuseWarningBanner.tsx`: zero-props, self-fetching client component (same convention as
    `OnboardingBanner`/`PendingInvitationsBanner`), fetching `GET /api/me/stepup` on mount. At
    `warned`: a dismissible (per-stage, `sessionStorage`-remembered so it isn't a permanent
    dismiss) fairness-framed notice ("Just so you know... no action needed right now"). At
    `stepup` with `requiresStepUp: true`: a non-bypassable password-challenge `Dialog` ("Please
    confirm it's you... this is a routine check, not an accusation") — dismissing the dialog just
    re-shows it next load since the requirement lives server-side, not in component state.
    `throttled`/`blocked` intentionally have no UI here (`blocked` is already rejected at the
    request layer by Phase 5 task 1; `throttled` is a rate-limit concern for a later task, not a
    banner). New `src/routes/api/me/stepup/index.ts`: `GET` reports `{stage, requiresStepUp}` via
    `resolveEnforcementForUser`; `POST` verifies the supplied password via better-auth's own
    `auth.api.verifyPassword` (confirmed via research to already exist in better-auth core, no new
    dependency) and on success sets a signed `bh_stepup` cookie. Rate-limited 5/5min per user
    against password-guessing.
    New `src/shared/lib/auth/stepup.ts`: no persisted "verified at" column exists anywhere in this
    schema (confirmed by research — `auth_sessions`/`auth_users`/`account_risk` all lack one, and
    the existing "recent auth" convention in `billing/permissions.ts` means something different —
    session *age*, not a password re-check), so step-up verification is recorded in a signed,
    15-minute HttpOnly cookie (same HMAC-with-`BETTER_AUTH_SECRET` convention as
    `abuse/device.ts`'s `computeDeviceHash`, constant-time-compared) rather than a new migration —
    reasonable for something this short-lived and session-scoped. Also exports `requireStepUp`, a
    reusable guard for a future "sensitive action" route to call — not wired into a specific route
    yet since neither the task text nor spec.md names one (same "primitive ready, not yet
    connected" pattern as G7/G1).
    `_dashboard/route.tsx`: `<AbuseWarningBanner />` now renders dashboard-wide (a new pattern —
    the two existing banners are dashboard-HOME-page-only — justified because the step-up gate
    needs to appear on every page, not just the landing one).
    22 new unit tests for `auth/stepup.ts` (cookie sign/verify roundtrip, expiry boundary,
    tampered-signature rejection, `requireStepUp`'s stage gating) and 8 new component tests for
    `AbuseWarningBanner.tsx` (stage-by-stage rendering, dismiss-per-stage, password submit
    success/failure) — all pass. Discovered and worked around a real happy-dom (vitest's test
    environment) limitation while writing the `requireStepUp` tests: happy-dom's `Request`
    constructor silently strips the `Cookie` header (enforcing the Fetch spec's "forbidden
    request header" rule, which is meant for outgoing `fetch()` calls, not inbound server
    requests — confirmed via a throwaway script that real Node's `undici` preserves it fine) —
    worked around by duck-typing a minimal `{headers: {get}}` object in the test instead of a real
    `Request`, since `requireStepUp` only ever calls `.headers.get('cookie')`; the real production
    route is unaffected (it receives the browser's genuine incoming header). `pnpm tsc --noEmit`/
    `pnpm eslint` clean; `pnpm security:route-coverage` recognizes the new route (104 routes, still
    valid) using the same session-check guard pattern as `/api/me/sessions`. No regressions across
    `src/shared/lib/auth` + `src/modules/dashboard/components` + `src/shared/lib/abuse` (347 tests).
    **Live-verified the full flow end-to-end** in the real dev browser against the real database:
    temporarily set `ABUSE_ENFORCEMENT_MODE=enforce` in `.env.local`, restarted the dev server,
    signed up a fresh test account, manually inserted an `account_risk` row with `stage='warned'`
    — confirmed the fairness-framed banner rendered; updated the row to `stage='stepup'` —
    confirmed the password dialog appeared, that a wrong password showed "Incorrect password" and
    kept the dialog open, and that the correct password dismissed the dialog and stayed dismissed
    across a full page reload (proving the `bh_stepup` cookie round-trips correctly through a real
    browser, not just the duck-typed test). No console errors. Reverted the temporary
    `.env.local` override, restarted the server again, and confirmed via `curl` that the server is
    healthy with the setting back to its default (`observe`). Deleted the test account and all its
    cascaded rows from the dev database afterward.

- [x] **Platform-admin abuse console**
  - Files: `src/routes/api/admin/abuse/index.ts`, `src/routes/_dashboard/admin/abuse.tsx`,
    `src/modules/dashboard/components/AbuseConsole.tsx` (+ test)
  - Do: `abuse_signals` feed + linked-account clusters + per-account stage; manual actions (clear,
    warn, force step-up, block), each audited via `emitSecurityAudit` behind
    `requirePlatformAdminPrincipal`.
  - Verify: route-coverage (`pnpm security:route-coverage`), admin-only access test, audit-row test.
  - **Done.** Linked-account clusters already had their own route from Phase 3
    (`/api/admin/abuse/clusters`) — this task built the other two pieces the console needs and left
    clusters as-is rather than duplicating it.
    - `repositories/abuse-signals.ts`: added `listRecentAbuseSignals(limit, db?)` — unscoped,
      most-recent-first, bounded read (the table has no RLS/owning subject, so this is a plain
      sequential scan bounded by `LIMIT`, same risk profile the existing per-user/per-org readers
      already accept).
    - `repositories/account-risk.ts`: added `withPlatformUser` (mirrors `withWorkerUser` but runs
      under `builderhunt_platform`) and `setAccountRiskStageByAdmin(userId, stage, reason, deps?)`.
      Key design constraint discovered while researching: `builderhunt_platform` only has
      SELECT/UPDATE on `account_risk` (no INSERT — see 0044's grant split), so a manual action on a
      user with no existing risk row would fail outright. Fixed by ensuring a baseline row first via
      the worker role's INSERT grant with `ON CONFLICT DO NOTHING` (never resets an already-scored
      row), then applying the admin's stage under the platform role. Also confirmed via 0044's own
      comments that a bulk "list every flagged account" cross-user read is explicitly out of scope
      for both worker and platform RLS policies (both are still `app.user_id`-scoped) — so the
      console resolves stage per-account for only the unique user IDs appearing in the current
      signals page, not a global list.
    - `routes/api/admin/abuse/index.ts` (new): `GET` returns the recent signals feed plus a
      `stageByUserId` map (one `withPlatformUser` read per unique user ID in the page); `POST` takes
      `{ userId, action: 'clear'|'warn'|'stepup'|'block', reason? }`, maps action → `EnforcementStage`
      (`clear→observe`, `warn→warned`, `stepup→stepup`, `block→blocked`), calls
      `setAccountRiskStageByAdmin`, then audits via `auditPlatformAdminAction` with
      `action: 'admin.abuse.account.<action>'`, `targetType: 'account_risk'` — matching the
      `admin.<area>.<entity>.<verb>` convention already used by every other admin mutation route.
    - `modules/dashboard/components/AbuseConsole.tsx` (+ test) and
      `routes/_dashboard/admin/abuse.tsx`: same self-fetching zero-props page/component split as
      `BillingOperationsPage`/`admin/billing.tsx`, with an inline expand-a-row action form (no modal)
      matching `RefundQueue`'s established pattern. Added an "Abuse console" entry to `UserMenu`'s
      `ADMIN_LINKS`.
    - **Known limitation, not a blocker:** there is no persisted "admin locked this stage" flag
      anywhere in the schema. If the automated risk-scoring sweep (`recomputeAccountRisk`) re-runs
      for a user after a manual override, it can silently overwrite the admin's stage. Documented in
      code comments rather than fixed now — adding a lock column is a larger schema change than this
      task's scope, and the existing 0044 migration already defers the analogous "list all flagged
      accounts" feature for the same reason. Flagging here for future follow-up, not treating it as
      blocking.
    - **Real bug found and fixed during live verification:** the manual-action form was originally
      keyed by `userId`, not by signal ID. Since a single account can have many signals (very common
      in this dataset — one admin test account had 30+ `concurrent_sessions` signals), clicking
      "Act on account" on one row expanded the form under *every* row for that user simultaneously.
      Fixed by keying the expand/collapse state on `signal.id` instead.
    - **Live-verified end-to-end** in the real dev browser as the seeded platform admin
      (`edd_admin@local.com`, `ADMIN_USER_IDS`): confirmed admin-gated access via
      `_dashboard/admin/abuse.tsx`'s `beforeLoad`, saw the real `abuse_signals` feed (many real rows
      from earlier session activity) and the real linked-account clusters feed composed side by
      side. Seeded one `account_risk` row directly via `psql` to confirm the stage badge resolves
      correctly through the platform-role RLS read (`—` before seeding, `warned` after). Opened the
      manual-action form, used the shadcn `Select` to choose "Block", submitted with a reason,
      confirmed via `psql` that `account_risk.stage` flipped to `blocked` and the reason recorded
      admin attribution, and confirmed via `preview_logs` that both the `clear` (default-option) and
      `block` actions were each audited with the correct `action`/`targetType`/`targetId`/`result`.
      Deleted the seeded test row afterward — no lingering state.
    - Verify sweep: `pnpm tsc --noEmit`, `pnpm eslint` (0 errors — 2 pre-existing-style
      `set-state-in-effect` warnings matching every other self-fetching dashboard component),
      `pnpm vitest run` (40/40 across the touched files), `pnpm security:route-coverage` (105 routes,
      valid).

- [x] **Pricing/FAQ fair-use copy**
  - Files: `src/routes/_landing/pricing.tsx`
  - Do: state the seat/fair-use and per-seat concurrency policy so enforcement is expected.
  - Verify: content test / visual check.
  - **Done.** Added a new "Is there a fair-use policy?" entry to the inline `FAQ` array (this page
    has its own self-contained FAQ, separate from the homepage's `FAQSection.tsx` — nothing shared
    to touch). Deliberately used qualitative language ("a laptop and phone at once," "sized
    generously for real research work, not automated scraping") rather than hard-coding the current
    numeric thresholds (`SESSION_MAX_CONCURRENT_*`, `SEAT_DAILY_*` in `env.ts`) — those are tunable
    ops knobs pending Phase 6's baseline-calibration task, not a committed public contract, and
    `env.ts`'s own comment on session limits says they're "sized to comfortably allow a single
    person... not to police normal multi-device use." Matched the existing FAQ's voice (direct,
    reassuring, "Yes." opener, no legalese) and `spec.md`'s framing goal ("fairness, not
    accusation") by naming the in-app warning/step-up UX (Phase 5 tasks 1-2) before any restriction.
    Verify: `pnpm tsc --noEmit`, `pnpm eslint` (both clean), `pnpm vitest run
    src/routes/_landing/pricing.test.tsx` (7/7 passing, unaffected), and a visual check in the real
    dev browser confirming the new accordion entry renders with the rest of the FAQ list.

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
