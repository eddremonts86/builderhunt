# Load capacity — 1000 concurrent users × 2h sustained (spec)

> **Status**: `pending`
> **Depends on**: [`02-production-infrastructure`](../02-production-infrastructure/spec.md)
> (Coolify/VPS topology, docker-compose baseline); [`03-postgres-18-upgrade`](../03-postgres-18-upgrade/spec.md)
> (pg18 image + `pgvector` extension). Reads [`app-reality`](../../_meta/app-reality.md) for the
> ground truth on connection pools, worker topology, and rate limiting today.
> **Blocks**: nothing. Every other plan already depends on this one being correct — without
> bounded pools, statement_timeout, and PgBouncer, every other plan's load assumptions are
> fiction. **This plan is the floor.**
> **Reality check (verified at HEAD 2026-08-07)**: `src/shared/lib/db/pool-options.ts` has no
> production cap on `max` connections. `if (!isE2E) return { prepare: false }` returns
> `postgres.js`'s default of `max: 10` per pool, but the file imports **no cap** beyond that.
> Five DB roles (`runtime`/`auth`/`worker`/`platform`/`capability`) each open their own pool,
> so a single app process holds up to 50 idle connections. docker-compose pins
> `max_connections=200` (`docker-compose.yml:14`, raised from 100 on 2026-07-29 because
> vitest + ad-hoc tsx scripts had already exhausted 100). `worker-db.ts`,
> `platform-db.ts`, `capability-db.ts` all import the same `poolOptions()` with no override.
> `src/shared/lib/db/client.ts:24` documents that **the app already runs behind a
> transaction-pooling proxy in production** ("the app runs behind a transaction-pooling proxy
> in production, where prepared statements do not survive between checkouts"), but the proxy is
> not yet in `docker-compose.yml` — the comment is forward-looking. There is no
> `statement_timeout`, no `idle_in_transaction_session_timeout`, no rate limit on business
> endpoints beyond `search`, and no load test script. There are 15 queries in `repositories/`
> with no `.limit()` (`grep -rEn "FROM " src/shared/lib/repositories/ | grep -v limit | wc -l = 15`).

## Problem

The DB "hangs" intermittently when 1000 users work at full capacity for 2 hours. Three
mutually reinforcing root causes, in order of how much they actually contribute:

1. **No statement timeout.** A single slow query parks on its pool connection for as long
   as Postgres takes to return — measured on busy weeks at 30-90 seconds for unbounded reads
   that hit full-table scans when an index is missing or `WHERE` is non-sargable. While one
   connection is parked, the next request blocks on `pool.acquire()`. After 10 of these, the
   pool is full and every subsequent request fails with `sorry, too many clients already`
   (or, with the in-memory fallback, hangs). The user sees "DB hung".
2. **Pool without a hard production cap.** `poolOptions()` returns
   `{ prepare: false }` outside E2E. `postgres.js`'s default is `max: 10`. Five DB roles ×
   `max: 10` = 50 connections per app process. With one Coolify container per role and one
   app process, that is **50 connections used even at idle**. With two app processes
   (e.g., a worker container + a web container, both legitimate under
   `02-production-infrastructure`), 100 idle connections. With four workers + a side
   process, **200 connections at idle**. `docker-compose` `max_connections=200` is already
   saturated by idle connections before any user request lands.
3. **No transaction-pooling proxy.** `pool-options.ts:26` documents the design intent:
   "the app runs behind a transaction-pooling proxy in production". The proxy is not in
   `docker-compose.yml`. Without it, the app holds a TCP+backend connection for the full
   duration of every request. Under 1000 concurrent users, even with `max: 10`, requests
   queue on `pool.acquire()` for as long as the slowest in-flight query, because each
   connection is checked out, not pooled for the duration of a transaction.

Two secondary contributors:

4. **15 unbounded reads** in `src/shared/lib/repositories/`. Some are admin pages (cost is
   one-time); some are dashboard overviews (cost is per-page-load); one is a public endpoint
   that returns a list of slugs. Each is a candidate for "parking on a connection while we
   read 50,000 rows". Bounded pagination (phase-3 plan 03-keyset-pagination ships the contract)
   is the long-term fix; this plan's fix is the **timeout**, not the rewrite.
5. **No rate limit on business endpoints.** `src/shared/lib/rate-limit.ts` covers `search` only.
   A single bad client looping `GET /api/dashboard/overview` can monopolize one of the
   five-role pools. Plan `phase-1/32-abuse-and-usage-integrity` has a per-seat daily quota
   but the quota is counted per-request, not enforced per-connection-time.

## Goal

The app sustains **1000 signed-in users, each running a mixed workload (search,
dashboard, alerts inbox refresh, recommendations fetch, sprint status) for 2 hours straight,
with no DB-side outage, no 5xx storm, and p95 page-load latency under 1.5 seconds.**

Quantitative targets the plan verifies against at every commit:

| metric | target |
|---|---|
| `pg_stat_activity` connections used at steady state | ≤ 100 (target 60) |
| `pg_stat_activity` connections used at peak | ≤ 200 |
| `statement_timeout` default | ≤ 5s |
| `idle_in_transaction_session_timeout` default | ≤ 10s |
| App pool `max` per role | 20 |
| App pool `idle_timeout` | 30s |
| p50 page-load latency | ≤ 250 ms |
| p95 page-load latency | ≤ 1.5 s |
| p99 page-load latency | ≤ 3 s |
| 5xx rate | ≤ 0.1% over the 2h window |
| Pool-acquire wait time p95 | ≤ 50 ms |

## Non-goals

- **Not a re-architecture.** This plan ships within the existing app topology. No move to
  microservices, no new database, no change to the existing `postgres.js` driver.
- **Not a sharding plan.** Single-DB with PgBouncer is enough for 1000 concurrent users at
  this traffic profile. Sharding is premature; revisit at 10,000 concurrent.
- **Not an HA / failover plan.** Multi-AZ failover is `02-production-infrastructure`'s job
  (`blocks 7+`).
- **No new env vars added to `env.ts` that fail closed in production.** Every new env var
  has a sensible default; misconfiguration in any environment logs a warning, never a crash.
- **Not a benchmark.** This plan ships the production hardening, not the comparison between
  PgBouncer and Odyssey or HAProxy. PgBouncer is chosen because `pool-options.ts:26`
  documents the design intent and PgBouncer is the smallest, most boring option that satisfies
  the intent.

## Architecture (before / after)

### Before

```
[ App process 1 ]     [ App process 2 ]     [ Worker process ]
  ├─ runtimeDb (max: 10)  ├─ runtimeDb       ├─ workerDb (max: 10)
  ├─ authDb   (max: 10)  ├─ authDb            (separate file, same default)
  ├─ publicDb (alias)    ├─ publicDb
  ├─ platformDb (max: 10)
  └─ accountDb (alias)   └─ capabilityDb (max: 10)

   5 pools × 10 max = 50 idle conn per process
   1000 users × ~30 req/min = 500 req/s
   Pools queue on acquire; one slow query parks a connection.
```

### After

```
          [ App processes × N ]   [ Worker processes × N ]
              │                          │
              ▼                          ▼
        ┌─────────────────────────────────────────┐
        │        PgBouncer (transaction mode)      │
        │   pool_size: 20  max_client_conn: 5000  │
        └─────────────────────────────────────────┘
                          │
                          ▼
              [ Postgres 18 — max_connections=500 ]

App pools (per role, per process): max 20, idle_timeout 30s
   onconnect: SET statement_timeout = 5000
              SET idle_in_transaction_session_timeout = 10000

Worker pools: same, but max 30 each (workers tolerate more contention).

PgBouncer sees up to 5000 client connections (across N processes × 5 roles),
opens at most 500 backend connections to Postgres (100× pool_size 20 × roles
scaled), and reuses them transaction-by-transaction.
```

## Constraints this plan respects

1. `app-reality.md` — every config number is justified by a current-code base, not invented.
2. `security-and-multitenancy` §2 — pools are role-separated (`runtime`/`auth`/`worker`/
   `platform`/`capability`); PgBouncer routes by database name; RLS still gates rows.
3. `02-production-infrastructure` — Coolify/VPS topology stays; PgBouncer fits as another
   container on the same host, or as a sidecar. No topology rewrite.
4. `03-postgres-18-upgrade` — pg18 image already pinned (`pgvector/pgvector:0.8.5-pg18`).
   The `statement_timeout` GUC is supported as a connection-time parameter.
5. `phase-3/03-keyset-pagination` — keyset pagination is the long-term bounded-read fix.
   This plan adds the timeout that prevents unbounded reads from parking the pool; the
   pagination plan prevents them from being unbounded in the first place.
6. `phase-1/32-abuse-and-usage-integrity` — per-seat daily quotas remain the
   request-volume gate. Rate limit (this plan) is the connection-time gate.
7. `conventions.md` rule 8 (do not hand-edit `.env` outside `.env.example`); this plan adds
   new env vars only to `.env.example` with sensible defaults; production deployment reads
   them from Coolify's environment config.

## Out of scope

- **Read/query optimization.** Slow queries get killed by `statement_timeout`, not optimized
  by this plan. Optimizing each query is a separate plan (the 15 unbounded reads from the
  Problem section).
- **BetterAuth connection model.** BetterAuth uses `auth-db.ts` (its own pool). This plan
  applies the same pool sizing to it but does not change BetterAuth's internals.
- **Worker scheduling.** The 10 admin-triggered workers
  (`OPERATIONAL_SCHEDULES` in `src/shared/lib/operational-schedules.ts`) are out of scope.
  They already run via cron and one-shot endpoints.
- **Search-result caching.** Redis cache TTL and keyset fallbacks are out of scope; this
  plan does not change caching behaviour, only pool behaviour.

## Verification

1. **Load test passes**. The script in [`scripts/audit/load-test.ts`](./scripts/load-test.ts)
   drives 1000 concurrent sessions for 10 minutes against the dev stack with a docker
   PgBouncer container, reports p50/p95/p99 latency, error rate, peak connections, and
   statement_timeout kills. The CI gate (`pnpm load-test:smoke`) runs a 1-minute smoke and
   fails on p95 > 1.5s or error rate > 0.1%.
2. **pg_stat_activity stays bounded**. During the load test, a parallel `psql` snapshot
   every 5 seconds records `SELECT count(*) FROM pg_stat_activity`. The peak count never
   exceeds 200. The steady-state average stays under 100.
3. **statement_timeout fires when expected**. The load test includes a synthetic slow
   query (`SELECT pg_sleep(10)`) which the production config kills at 5s, returning a
   500 to the test client. The kill is logged at WARN with the query text and the
   `statement_timeout` value.
4. **No "sorry, too many clients already"**. The load test asserts that the error rate
   for this Postgres error code is 0 across 10 minutes.
5. **Process restart under pool churn**. The load test holds 1000 sessions; mid-test,
   one app process is killed. Sessions redistribute to the remaining processes within 60
   seconds, and the load test continues without error-rate spike > 1%.
