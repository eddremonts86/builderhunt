# Load capacity — Delivery Plan

> **Status**: `pending`

## Delivery principles

1. **Measure before fixing.** A 10-minute load test runs **before** any config change
   commits. The baseline numbers go into the spec's verification table. Every subsequent
   commit is judged against the baseline.
2. **One mechanism per commit.** Each of the five commits (timeout, pool cap, PgBouncer,
   rate limit, load test) is reversible on its own. A bad rollback does not regress the
   other four.
3. **Defaults are production-safe.** Every new env var has a default that works in
   production. Misconfiguration logs a warning, never crashes.
4. **No change to BetterAuth, the postgres.js driver, or the worker topology.** This plan
   sits at the config + compose layer only.

## Dependency map

```
A ["Phase 0: baseline load test (no changes)"] --> B ["Phase 1: statement_timeout + idle_in_transaction"]
A --> C ["Phase 2: per-role pool cap + idle_timeout"]
B --> D ["Phase 3: PgBouncer in docker-compose + prod compose"]
C --> D
D --> E ["Phase 4: rate limit on business endpoints"]
E --> F ["Phase 5: full load test + verification report"]
```

## Phase 0 — Baseline load test (no production changes)

### Outcome

A single JSON file `docs/operations/load-baseline-<date>.json` containing the current
behaviour of the app under 1000 concurrent sessions for 10 minutes, with zero production
configuration changes.

### Work

- Author `scripts/audit/load-test.ts` — a k6-or-Artillery-driven (or hand-rolled
  `postgres-js` + curl mix, whichever lands first) test that:
  - signs in 1000 seeded users (`pnpm db:seed:test-users` produces 1000 fixtures
    cheaply, or the script signs up 1000 fresh accounts on the dev stack),
  - drives a mixed workload (5% search, 60% dashboard overview fetch, 20% alerts inbox,
    10% recommendations, 5% sprint status),
  - records p50/p95/p99 latency, error rate, peak `pg_stat_activity` connections,
    statement-timeout kills, and "sorry, too many clients already" occurrences.
- Run it against the **current** dev stack (no PgBouncer, no statement_timeout). Capture
  the numbers.
- Document the baseline in `docs/operations/load-baseline-<date>.md` — a short table the
  plan author reads before every subsequent commit.

### Verify

`docs/operations/load-baseline-<date>.json` exists. The dev stack survives 10 minutes
without a hard crash. **The baseline numbers are the comparison point for every later
phase.** Numbers worse than the baseline are a regression and block the next phase.

## Phase 1 — `statement_timeout` + `idle_in_transaction_session_timeout`

### Outcome

Every connection from the app to Postgres sets `statement_timeout = 5000` and
`idle_in_transaction_session_timeout = 10000` at connection time. A query that runs for
more than 5 seconds is killed by the database, not by the app's pool exhaustion.

### Work

- Add `onconnect` hook to `poolOptions()` in
  [`src/shared/lib/db/pool-options.ts`](../../src/shared/lib/db/pool-options.ts).
- Read `DATABASE_STATEMENT_TIMEOUT_MS` (default `5000`) and
  `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` (default `10000`) at pool construction time.
- Add both to `src/shared/lib/env.ts` as optional, with defaults; add to `.env.example`.
- Keep `prepare: false` (PgBouncer transaction mode requires it; see
  `pool-options.ts:26`).
- Test in `tests/unit/shared/lib/db/pool-options.test.ts`: a slow query is killed at
  the configured timeout.

### Verify

`pnpm vitest run` green. Re-run the load test from Phase 0; `statement_timeout` kills
the synthetic slow query at 5s, error rate does not exceed the baseline by more than 5%.

## Phase 2 — Per-role pool cap + `idle_timeout`

### Outcome

Every pool (runtime, auth, worker, platform, capability) has an explicit `max` cap and
`idle_timeout` configurable from the environment. Defaults are 20 and 30 seconds
respectively. The `postgres.js` default of 10 (and the absence of an idle_timeout)
ceases to apply.

### Work

- Replace the `if (!isE2E) return { prepare: false }` line in `poolOptions()` with an
  env-driven shape: `{ prepare: false, max, idle_timeout, onconnect }`. The values come
  from `env.DATABASE_POOL_MAX` (default 20), `env.DATABASE_IDLE_TIMEOUT` (default 30),
  and the timeouts from Phase 1.
- E2E still gets `max: 3, idle_timeout: 20` (`pool-options.ts:25`).
- Document in the spec why 20 is the right number (10 from the baseline + headroom for
  PgBouncer sharing) — not 100, not 50. The plan author calibrates this in Phase 0.

### Verify

Re-run load test. `pg_stat_activity` count stays below 100 steady-state, below 200 peak.
No regression in latency.

## Phase 3 — PgBouncer in `docker-compose.yml` + production compose

### Outcome

A `pgbouncer` service in `docker-compose.yml` runs alongside Postgres on port `6432`. The
app connects through PgBouncer. Postgres `max_connections=500`; PgBouncer
`pool_size=20, max_client_conn=5000, pool_mode=transaction`.

### Work

- Add the `pgbouncer` service block to `docker-compose.yml`. Reuse the existing
  `pgvector/pgvector:0.8.5-pg18` Postgres image — no version bump.
- Bump `max_connections` from 200 to 500. Bump `shared_buffers` to 512MB and
  `effective_cache_size` to 2GB on the Postgres command line.
- Add `pgbouncer/` directory with `userlist.txt`, `pgbouncer.ini`, and `Dockerfile`
  (or use `bitnami/pgbouncer:1.22` directly — the simpler choice).
- Update the dev `.env` so `DATABASE_URL` points to PgBouncer (`localhost:6432`) instead
  of Postgres (`localhost:5432`). Add `DATABASE_AUTH_URL`, `DATABASE_WORKER_URL`,
  `DATABASE_PLATFORM_URL` all pointing to PgBouncer with different database names
  (already split in env.ts).
- For production: `02-production-infrastructure` owns the production compose. The
  plan author adds a one-line `pgbouncer` service to whatever compose Coolify uses
  today; the topology stays `app → pgbouncer → postgres`.

### Verify

Re-run load test. With PgBouncer pooling in front of Postgres, peak `pg_stat_activity`
is at most `pool_size × 5 roles × app processes` — under 200 even at peak. p95 latency
is unchanged or lower than Phase 2.

## Phase 4 — Rate limit on business endpoints

### Outcome

A middleware (or `loader`-time check) on every `/api/*` route except `/api/auth/*`
applies a per-user rate limit. The default is 60 requests per minute per user-id.
The limit covers the connection-time cost: one bad client looping
`GET /api/dashboard/overview` does not monopolize a pool connection.

### Work

- Extend `src/shared/lib/rate-limit.ts` (currently scoped to search) with a generic
  helper `rateLimit(key, limit, windowMs)`. The key is `${userId}:${route}` so
  per-user, per-route limits compose.
- Add the helper to every `/api/dashboard/*`, `/api/builders/*`, `/api/alerts/*`,
  `/api/shortlists/*`, `/api/sprints/*` route loader. Not a global middleware — explicit
  per-route keeps audit trails clear.
- The `search` rate limit stays as-is.
- 429 responses include a `Retry-After` header.

### Verify

Re-run load test. Synthetic client that fires 1000 requests/sec from one user gets
429s after the first 60 in a window; the rest of the 999 users are unaffected.

## Phase 5 — Full load test + verification report

### Outcome

`docs/operations/load-verification-<date>.md` is the plan's done-state: every quantitative
target from the spec's Goal section is met or the plan is not done.

### Work

- Run the Phase 0 load test against the new stack. Capture the post-state numbers.
- Compare against the Phase 0 baseline. Every target met (or exceeded): connections,
  latency, error rate, statement_timeout kills, "sorry" occurrences.
- Document the verification report. Link it from the plan's Status header.
- Add `pnpm load-test:smoke` to `ci:local` — a 1-minute version of the load test. CI fails
  if it does not pass.

### Verify

`docs/operations/load-verification-<date>.md` lists the targets and the achieved numbers.
Every target is met or exceeded. The plan's Status header flips to `closed`.

## Order of commits

```
test(load): baseline load test runner + first run
fix(db): statement_timeout + idle_in_transaction_session_timeout
fix(db): per-role pool cap + idle_timeout (env-driven)
chore(compose): add PgBouncer; bump postgres max_connections + memory
feat(rate-limit): per-user rate limit on business endpoints
docs(load): verification report
ci: add pnpm load-test:smoke to the local gate
```

7 commits. Each is reversible on its own.

## Risks

1. **PgBouncer breaks BetterAuth's auth flow.** BetterAuth uses prepared statements;
   `pool-options.ts:26` documents `prepare: false` because "prepared statements do not
   survive between checkouts" in transaction-pooling mode. **This is already a
   pre-existing constraint.** The plan author verifies BetterAuth's startup flow under
   PgBouncer before Phase 3 lands.
2. **statement_timeout kills legitimate long queries.** A 5-second default kills any
   admin-paged query that hits a slow path. The plan author keeps the timeout configurable
   per-route via `DATABASE_STATEMENT_TIMEOUT_MS` (and a per-route override header for
  ops); the default is 5s but `/api/admin/*` can opt up to 60s.
3. **PgBouncer is a new dependency.** The Coolify deployment template must include it.
   `02-production-infrastructure` ships the production compose that adds the service;
   this plan only ships the dev compose.
4. **Load test is local, not prod.** The load test runs against the dev stack with
   `pnpm dev`. Production has different hardware (Hetzner VPS vs Mac dev). The plan ships
   the smoke gate for CI; a full production load test is a separate ops task.

## Rollback

Each phase is a single commit. `git revert <commit-hash>` returns to the prior state.
PgBouncer is the biggest blast radius; reverting Phase 3 means app connections go back to
Postgres directly, which is what works today (just at the documented 50-connection idle
floor).
