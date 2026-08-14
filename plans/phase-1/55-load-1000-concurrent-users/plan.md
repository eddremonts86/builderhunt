# Load capacity — Delivery plan

> **Status**: `pending`
> **Depends on**: [`02-production-infrastructure`](../../implemented/phase-1/02-production-infrastructure/spec.md),
> [`03-postgres-18-upgrade`](../../implemented/phase-1/03-postgres-18-upgrade/spec.md)
> **Blocks**: nothing
> **Reality check**: the production app currently connects directly to the Coolify PostgreSQL
> resource. The generic Redis/in-memory limiter already exists and several workload routes already
> use it; this plan changes connection lifecycle and deployment topology, not request policy.

## Delivery rules

1. Use the same app image, host class, fixture set, request schedule, and measurement code for the
   direct baseline and pooled calibration.
2. Keep `DATABASE_MIGRATION_URL` direct at every phase.
3. Never commit credentials, generated `userlist.txt`, raw cookies, or unredacted URLs.
4. Do not run the two-hour soak or change Coolify without explicit operator confirmation.
5. A 10-minute or CI run cannot close the plan; only the two-hour certification can.

## Dependency map

```text
load contract + fixtures + runner
          ├──> direct baseline
          ├──> canonical role pools ──┐
          └──> role timeouts ─────────┼──> PgBouncer local integration
                                      └──> production-sized calibration
                                                     └──> 2-hour soak + report
```

## Phase 0 — Freeze the reproducible workload

Create a Node/TypeScript harness under `scripts/load/`; do not introduce a second test runner. It
must seed 1,000 deterministic users and non-empty tenant data into a disposable database, sign in
through Better Auth, validate every route once, ramp virtual users, collect bounded histograms, and
write redacted JSON plus Markdown.

The runner owns cancellation and timeout behavior. Each request has a 10-second client timeout.
The route mix and two-second think time are constants tested in
`tests/unit/scripts/load/config.test.ts`. A run manifest records commit SHA, app image digest,
host CPU/RAM/architecture, database version, pool mode, user count, duration, and thresholds.

Exit codes are contractual: `0` thresholds passed, `1` thresholds failed, `2` invalid setup, and
`130` interrupted after writing a partial artifact.

## Phase 1 — Capture the direct baseline

Run the 10-minute profile against a production build connected directly to PostgreSQL. Use the
same disposable database and production-sized host intended for calibration. Record failures even
if the app or database collapses; a failed baseline is evidence, not a prerequisite for the fix.

Commit only `docs/operations/load-baseline-<date>.md`. Upload raw JSON as an artifact.

## Phase 2 — Bound and consolidate app pools

Change `poolOptions()` to `poolOptions(role)` with the five-role union and the defaults from the
spec. Add validated env overrides:

```text
DATABASE_RUNTIME_POOL_MAX=16
DATABASE_AUTH_POOL_MAX=4
DATABASE_WORKER_POOL_MAX=8
DATABASE_PLATFORM_POOL_MAX=4
DATABASE_CAPABILITY_POOL_MAX=4
DATABASE_POOL_IDLE_TIMEOUT_SECONDS=30
DATABASE_POOL_CONNECT_TIMEOUT_SECONDS=5
```

Retain the E2E override. Move all imports to the lazy platform client exported by `db/client.ts`
and delete the second singleton from `db/platform-db.ts` (a compatibility re-export is acceptable
for one commit, but it must reference the same object). Add `application_name` per role so
`pg_stat_activity` identifies the client.

Unit tests assert pure option selection. An integration test exercises all five exact roles; it
must not attempt to inspect a private `drizzle` client field.

## Phase 3 — Enforce database-role timeouts

Add one new Drizzle migration with `ALTER ROLE ... SET statement_timeout` and
`ALTER ROLE ... SET idle_in_transaction_session_timeout` for the five login roles. Mirror the
settings in `scripts/db/roles.sql` so a restore/bootstrap preserves them.

Do not edit an applied migration. Do not add an unsupported `onconnect` option and do not send a
session `SET` through transaction pooling. Tests query `SHOW` as each exact role, directly and later
through PgBouncer, and verify SQLSTATE `57014` with a bounded `pg_sleep` probe.

## Phase 4 — Add PgBouncer locally

Build PgBouncer 1.25.2 from upstream in a multi-stage ARM64/AMD64 image. The build pins and verifies
the source checksum. Add a compose service and healthcheck with these caps:

```ini
pool_mode = transaction
default_pool_size = 12
reserve_pool_size = 4
max_db_connections = 80
max_client_conn = 500
auth_type = scram-sha-256
```

Generate the auth file at container start into `tmpfs`; never commit it. Bind local port 6432 to
loopback. Keep PostgreSQL at `max_connections=120`; do not apply speculative `shared_buffers` or
`effective_cache_size` changes in the connection-capacity commit.

Add a readiness script that proves all five roles can execute `SELECT 1` through PgBouncer, the
migration role still connects directly, the role timeouts survive pooling, and `SHOW POOLS` never
exceeds the configured database cap.

## Phase 5 — Calibration and CI smoke

Repeat the 10-minute run through PgBouncer. If thresholds fail, use route histograms, PostgreSQL
activity, PgBouncer waiting-client samples, and host saturation to identify the bottleneck. Pool
numbers may only be lowered or changed within the hard 80-backend/120-PostgreSQL budget; every
change updates the spec table and report.

Add `test:load:smoke` and a dedicated `.github/workflows/load-smoke.yml` job that provisions
PostgreSQL, Redis, PgBouncer, a production app build, and 25 users for 30 seconds. It uploads raw
artifacts on success and failure. The normal `pnpm ci:local` gate remains required but does not
pretend a desktop smoke is the capacity certificate.

## Phase 6 — Two-hour certification and production rollout

Document the exact Coolify service, private-network host names, role-secret injection, healthcheck,
and rollback. Repoint only the five runtime role URLs; keep the migration URL direct. Run deploy
preflight, auth smoke, RLS/API-isolation checks, and a low-rate route smoke before any load.

**Changed 2026-08-14.** This paragraph read "the two-hour load runs against an isolated
4-vCPU/8-GB ARM64 environment, not the customer-facing production app". Both halves moved.

The load now runs on the **production host, pooler and PostgreSQL instance**, for the reason
[`docs/operations/load-testing.md`](../../../docs/operations/load-testing.md) gives: the real
Coolify private network, the real pooler and the real host only exist there, and a box somewhere
else measures a different system.

The fixture, however, goes in a **disposable `builderhunt_load_test_*` database on that instance**,
and the app is repointed at it for the window. Nothing being certified changes — same CPU, disk,
pooler and instance-wide `max_connections` — but the fixture never enters `builderhunt`, and
cleanup is a `DROP DATABASE` rather than deleting a thousand rows from the live one. The hazard
this plan worried about, an aborted run leaving a thousand accounts that share one password on a
public site, stops being a step somebody has to remember and becomes impossible by construction.

What still rests on beta is the *window itself*: for a few hours the live site serves the load
fixture and answers under saturation. That is defensible with no real users and expires the day
there are some. Re-read this before any run once the product has users.

Starting sustained 1,000-user traffic against a public site is an outward-facing operator action
and requires confirmation immediately before the run, plus a verified-restorable backup of
`builderhunt` — the load never writes to it, but the app is redeployed twice and PostgreSQL is
restarted for `max_connections`.

Only after certification passes, roll out PgBouncer as a dark healthy Coolify service, lower the
production resource to `max_connections=120` during an approved restart window, repoint the five
runtime URLs, redeploy, and perform low-rate auth/RLS/route smoke checks. No high-rate production
canary is implied by this plan.

Close the plan only after `docs/operations/load-certification-<date>.md` records every success
criterion, the exact artifact identifiers, and a pass. If the host is CPU-saturated before the DB
targets fail, report application capacity as the bottleneck; do not raise database connections.

## Commit sequence

```text
test(load): add deterministic fixtures and HTTP load harness
docs(load): record direct database baseline
fix(db): consolidate and bound role-specific pools
fix(db): enforce per-role query and transaction timeouts
build(pgbouncer): add pinned multi-arch pooler and secret-safe config
test(load): add pooler readiness and CI smoke workflow
docs(ops): document Coolify pooler rollout and rollback
docs(load): record two-hour capacity certification
ops(db): route production runtime roles through PgBouncer
```

The migration and `scripts/db/roles.sql` mirror must land together. PgBouncer configuration and the
readiness check must land together. Do not split either invariant across deployable commits.

## Risks and mitigations

| risk                                               | mitigation                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Transaction pooling breaks session state           | Keep `prepare: false`; test Better Auth, tenant context, and every role through PgBouncer before rollout. |
| Auth-file secrets leak                             | Generate into container `tmpfs`, mode `0600`; redact environment and URLs from logs/artifacts.            |
| A five-second timeout kills legitimate worker work | Worker has a 30-second role default; existing backfills retain explicit `SET LOCAL` overrides.            |
| Pool caps merely move failure into a queue         | Sample `cl_waiting` and `maxwait`; fail certification when queue targets are missed.                      |
| 1,000 empty tenants produce a false green result   | Seed bounded but non-empty dashboard, builder, alert, recommendation, and sprint data.                    |
| External providers distort DB results              | Keep them disabled in the core profile; report cached federated search separately.                        |
| ARM image is unavailable or vulnerable             | Build 1.25.2 from upstream and verify both target architectures plus `pgbouncer --version`.               |
| Rollout locks out migrations                       | Migration URL never traverses PgBouncer and is checked before runtime URLs are changed.                   |
| The 4-vCPU app saturates before PostgreSQL         | Report the actual bottleneck; do not “fix” CPU saturation by raising connection counts.                   |

## Rollback

1. Stop new load and preserve the partial artifact.
2. In Coolify, restore the five runtime URLs to the direct PostgreSQL host and redeploy the previous
   green app image. Do not change `DATABASE_MIGRATION_URL`.
3. Verify `/api/health`, sign-in, dashboard overview, and one exact-role RLS probe.
4. Stop the PgBouncer service only after direct traffic is healthy.
5. Pool-option and timeout commits are independently revertible. Role defaults may be reset with a
   new migration/approved operator command; never edit the applied migration.

Rollback restores availability, not the 1,000-user guarantee. The incident report must retain the
PgBouncer and PostgreSQL samples that triggered rollback.
