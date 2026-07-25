# Abuse Observe-Window Baseline Report

## What this report is for

Every abuse-enforcement threshold shipped so far (`SESSION_MAX_CONCURRENT_*`, `SEAT_DAILY_*`,
`SIGNUP_DEVICE_DAILY_LIMIT`, `ABUSE_CROSS_TENANT_DENIAL_THRESHOLD`, and the rest in
`src/shared/lib/env.ts`) is a placeholder default picked before any real usage data existed —
`env.ts`'s own comments describe them as "sized to comfortably allow... not to police normal use,"
not a calibrated number. `ABUSE_ENFORCEMENT_MODE=observe` exists specifically so `abuse_signals`
and `account_risk` accumulate real signal without ever blocking anyone, and this report is how that
observe-window data gets turned into a real calibration decision before Phase 6's "Staged enforce
rollout" task flips anything to `warn`/`enforce`.

`pnpm abuse:baseline-report` (`scripts/abuse/baseline-report.ts`) is read-only and queries:

- **Devices per user, by tier** (`user_devices`, tier resolved via the user's oldest organization
  membership → `organization_entitlements.tier`, falling back to `free` for users with no
  organization).
- **Distinct IPs per user in the window, by tier** (`auth_sessions.ip_address` — the only raw-IP
  source in the schema; the abuse-specific `session_signals` table stores only derived booleans,
  never a raw IP, so it can't answer this on its own).
- **Per-seat daily action counts, by tier and action** (`seat_usage_daily`, median and p95 via
  `percentile_cont`).
- **`abuse_signals` counts by type/severity** in the window.
- **Current `account_risk` stage distribution** — i.e., how many accounts would already sit at each
  enforcement stage if `enforce` were flipped on right now.
- **`session_signals` flag rates** (`concurrent_distinct_ip`, `impossible_travel`,
  `mid_session_ua_change`, `new_device`) as a fraction of all sessions in the window.

## Why this needs `DATABASE_MIGRATION_URL`

`user_devices`, `account_risk`, and `seat_usage_daily` are RLS-protected, each scoped to a single
`app.user_id`/`app.organization_id` per transaction (`drizzle/0044_abuse_usage_integrity_rls_grants.sql`).
An unscoped connection sees **zero rows on those tables, not all rows** — there is no
runtime role (`builderhunt_app`/`builderhunt_worker`/`builderhunt_platform`) with an unscoped
cross-user policy on them, and building one is explicitly deferred per 0044's own comments ("a
'list all flagged accounts' view is a separate, deferred task"). A genuine cross-user/cross-org
aggregate therefore needs the real Postgres superuser connection
(`DATABASE_MIGRATION_URL`) — the same connection `scripts/db/backfills/organizations.ts` uses for
its cross-tenant backfill. This script only ever runs `select`s; it has no write path.

## Running the report

```sh
pnpm abuse:baseline-report                    # 30-day window (default)
pnpm abuse:baseline-report --window-days=90
```

Output is a single JSON object printed to stdout — safe to paste into an incident channel or a
calibration ticket, since it contains only aggregate counts/medians, never a raw user ID's PII
beyond what's already in `abuse_signals`/`account_risk` (`user_id`/`organization_id`, the same
identifiers those tables already store).

## How to read the output when calibrating a real threshold

- **`deviceMediansByTier`** — compare the median against `SESSION_MAX_CONCURRENT_*`. If the real
  median for a tier already sits at or above the configured cap, that cap is too tight and would
  generate false-positive `warned`/`stepup` stages for normal multi-device use the moment
  enforcement moves past `observe`.
- **`distinctIpMediansByTier`** — a rough proxy for "how many different networks does a normal user
  actually connect from in a month" (home, mobile carrier, office, coffee shop). Use this to sanity
  check `abuse/anomalies.ts`'s `concurrent_distinct_ip` signal threshold, not as a hard cap on its
  own.
- **`seatActionMediansByTier`** — compare median/p95 against `SEAT_DAILY_SEARCHES`/`_REVEALS`/
  `_EXPORTS`/`_MESSAGES`. A cap set below the real p95 for legitimate usage will throttle real
  customers before it ever catches an automated scraper.
- **`abuseSignalCounts`** — the raw signal volume by type. A `type` with a very high count relative
  to total active users likely means its trigger condition is too sensitive (tune the signal, not
  just the downstream enforcement stage).
- **`accountRiskStageDistribution`** — this is the single most important number before any `enforce`
  flip: it's exactly how many real accounts would move to each stage today. A large `blocked`/
  `throttled` bucket here is a loud signal to widen thresholds before flipping modes, not proceed.
- **`sessionSignalFlagRates`** — flag rate as a fraction of total sessions. If a flag fires on a
  large fraction of all sessions, it's not discriminating abuse from normal use and needs
  retuning before it's allowed to influence `account_risk.stage`.

**Dev/staging data is not production data.** A local run against the dev database mixes real
session-hook activity from this session's own live-verification work (repeated sign-ins, seeded
test rows, a single heavily-reused admin account) with a handful of real test-org rows — do not
copy a dev-environment run's numbers directly into `env.ts`. Re-run this report against the real
production database once it has a genuine, representative observe window (the plan's own guidance:
let `observe` mode run long enough to see real weekly usage cycles, not just a few days of internal
testing) before picking final threshold values.

## ASN allowlist — not populated, by design, not an oversight

`ABUSE_ALLOWLIST_ASNS` (`env.ts`) exists and `isAllowlistedAsn()` (`abuse/anomalies.ts`) is wired to
consume it, but **no IP→ASN resolution capability exists anywhere in this codebase** — no geo-IP or
ASN-lookup dependency is installed, `user_devices.last_ip_asn` and `session_signals.ip_asn` are both
always `null` today, and this was an explicit, documented scope decision earlier in this same plan
(`abuse/linked-accounts.ts`'s header comment; `tasks.md`'s own Phase 3 record: "this codebase has
zero IP→ASN resolution capability... ASN explicitly deferred"). The report above cannot produce real
ASN data because none is captured — populating `ABUSE_ALLOWLIST_ASNS` with real corporate-network
ASNs is only possible after a separate decision to add a geo-IP/ASN resolution dependency, which is
out of scope for this baseline-calibration task. Until then, leave `ABUSE_ALLOWLIST_ASNS` empty
rather than guessing at ASN numbers with no way to verify them against real traffic.
