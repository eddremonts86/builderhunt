# Load capacity — 1,000 concurrent authenticated users (spec)

> **Status**: `pending`
> **Depends on**: [`02-production-infrastructure`](../../implemented/phase-1/02-production-infrastructure/spec.md),
> [`03-postgres-18-upgrade`](../../implemented/phase-1/03-postgres-18-upgrade/spec.md)
> **Blocks**: nothing
> **Reality check**: `src/shared/lib/db/pool-options.ts` leaves production on the
> `postgres.js` default of 10 connections per client and only caps E2E at 3. The runtime creates
> five role-specific clients plus a second platform client exported from `db/client.ts` and
> `db/platform-db.ts`. `src/shared/lib/rate-limit.ts` is already Redis-backed and generic;
> `scripts/db/seed-test-users.ts` creates three users, not 1,000. There is no load harness or
> PgBouncer service at HEAD (verified 2026-08-09).

## Decision

Protect PostgreSQL with three independent controls:

1. one canonical app pool per database role, with an explicit per-process connection budget;
2. database-role statement and idle-transaction timeouts that also apply behind transaction
   pooling;
3. PgBouncer 1.25.2 in transaction mode, with a hard database-wide backend cap.

Capacity is certified by a 1,000-session, two-hour soak **against production**, during beta, with
an approved window. The 10-minute run is a calibration gate, not evidence for the two-hour claim.
Rate limiting is not part of the capacity fix: legitimate traffic must pass without being converted
to `429`.

> **Changed 2026-08-14.** This spec said "on an isolated production-sized host" until then, and
> [`docs/operations/load-testing.md`](../../../docs/operations/load-testing.md) had said the
> opposite since 2026-08-11: certify against production, because the real Coolify private network,
> the real pooler and the real host only exist there, and a 4-vCPU box somewhere else measures a
> different system. During beta there are no real users and the database is expendable, which is
> what makes it defensible. The doc's decision is the newer and the reasoned one; the spec was
> stale, and every task below now names production.

## Problem

The current connection budget is implicit and multiplied by client objects and app processes.
`postgres.js` opens connections lazily, so this is a maximum rather than an idle floor, but the
worst case is still unbounded at the deployment level:

- runtime, auth, worker, capability, and **two** platform clients can each grow to 10 connections;
- a second app process doubles that ceiling;
- requests wait behind slow queries with no role-level `statement_timeout`;
- production connects directly to the Coolify PostgreSQL resource;
- no repeatable workload proves the service survives the stated concurrency or duration.

PgBouncer does not make slow SQL faster and does not replace bounded application pools. It limits
the number of PostgreSQL backends and turns excess demand into a measurable queue instead of a
database-wide connection failure.

## Load contract

“1,000 concurrent users” means all of the following, not 1,000 simultaneous TCP connections:

- 1,000 distinct authenticated sessions are kept live for the steady-state window.
- Each virtual user performs one request, waits two seconds plus deterministic jitter in the
  range 0–500 ms, then repeats. The expected offered rate is 400–500 requests/second.
- The runner ramps from 0 to 1,000 users over two minutes. Thresholds are evaluated after ramp-up.
- The workload is read-heavy and uses seeded local data only:
  - 45% `GET /api/dashboard/overview`
  - 15% `GET /api/builders/recent`
  - 15% `GET /api/alerts/triggers/unread-count`
  - 15% `GET /api/recommendations`
  - 10% `GET /api/sprints/:sprintId/results`
- A separate 5% federated-search profile may be run after warming its cache. It is reported
  separately because third-party latency is not PostgreSQL capacity.
- Every endpoint is exercised once during fixture validation before the timed run. A missing
  fixture, `401`, `403`, `404`, or feature-disabled response aborts instead of becoming load.
- The load database is disposable and contains enough per-organization rows to avoid certifying
  empty-state queries. External AI, email, payment, and scraping calls remain disabled.

## Certification stages

1. **Baseline** — 10 minutes, direct app-to-PostgreSQL, same build, data, host, and workload.
2. **Calibration** — 10 minutes through PgBouncer. Tune only within the connection budget below.
3. **Soak** — two hours through PgBouncer against production: the CAX21 host documented in
   `docs/operations/host-maintenance.md`, its own Coolify private network, and the pooler that
   will actually serve traffic. Approved window, named owner, fresh backup first.
4. **Smoke** — 25 users for 30 seconds in a dedicated CI workflow. This detects broken wiring;
   it does not certify 1,000 users.

Raw samples are CI artifacts under `artifacts/load/` and are not committed. The repository keeps
the redacted baseline and certification summaries under `docs/operations/`.

## Connection budget

### Application clients (per app process)

| role       | default `max` | statement timeout | idle-in-transaction timeout |
| ---------- | ------------: | ----------------: | --------------------------: |
| runtime    |            16 |               5 s |                        10 s |
| auth       |             4 |               5 s |                        10 s |
| worker     |             8 |              30 s |                        30 s |
| platform   |             4 |              15 s |                        10 s |
| capability |             4 |               5 s |                        10 s |

Total: 36 possible PgBouncer client connections per app process. `idle_timeout` is 30 seconds and
`connect_timeout` is 5 seconds for every role. E2E keeps its existing `max: 3` and
`idle_timeout: 20` override.

The initial values are conservative starting points, not proof. Calibration may lower them.
Raising them requires updating this table and proving that:

```text
app process count × sum(per-role max) < PgBouncer max_client_conn
```

### PgBouncer and PostgreSQL

```text
PgBouncer pool_mode              transaction
PgBouncer default_pool_size      12 per (database, user) pool
PgBouncer reserve_pool_size       4 per pool
PgBouncer max_db_connections     80 across all role pools
PgBouncer max_client_conn       500
PostgreSQL max_connections      120
```

Five role users therefore consume at most 60 normal and 80 peak PgBouncer backends. PostgreSQL
retains 40 connections for the migration URL, monitoring, backup, and operator access. These are
hard caps; the plan does not raise PostgreSQL to 500 connections on an 8-GB host.

`default_pool_size` is per `(database, user)` pool, not a global number. This is why the design also
sets `max_db_connections=80` and verifies `SHOW POOLS`/`SHOW STATS` instead of multiplying an
informal pool-size estimate.

## Timeout design

The plan does **not** use an `onconnect` callback: `postgres@3.4.9` has no such option. It also does
not rely on session `SET` commands, which are unsafe assumptions in transaction mode.

Timeouts are applied with `ALTER ROLE ... SET` in a new migration and mirrored in
`scripts/db/roles.sql`, so every new PostgreSQL backend inherits the correct values whether the
client connects directly or through PgBouncer. Backfills that already use `SET LOCAL
statement_timeout` keep their explicit transaction-scoped override.

`prepare: false` remains set on all app clients. `DATABASE_MIGRATION_URL` always bypasses PgBouncer
so migrations, role provisioning, backup, and restore do not run through transaction pooling.

## PgBouncer deployment and secrets

- Build PgBouncer 1.25.2 from the signed upstream release in
  `docker/pgbouncer/Dockerfile`; pin the release checksum and verify both `linux/amd64` and
  `linux/arm64`. Do not use the stale `pgbouncer/pgbouncer` Docker Hub image or the old
  `bitnami/pgbouncer:1.22` draft.
- `docker/pgbouncer/pgbouncer.ini` contains no credentials.
- An entrypoint writes `userlist.txt` into a `tmpfs` from the five explicit role-password
  environment variables (`PGBOUNCER_RUNTIME_PASSWORD`, `PGBOUNCER_AUTH_PASSWORD`,
  `PGBOUNCER_WORKER_PASSWORD`, `PGBOUNCER_PLATFORM_PASSWORD`, and
  `PGBOUNCER_CAPABILITY_PASSWORD`) plus a dedicated `PGBOUNCER_ADMIN_PASSWORD`, sets mode `0600`,
  and never prints their values. No generated auth file is committed or stored in a host-mounted
  volume.
- Local compose exposes PgBouncer only on `127.0.0.1:6432`.
- Production PgBouncer is a separate Coolify service on the private network between the app and
  the managed PostgreSQL resource. Runtime/auth/worker/platform/capability URLs use the pooler;
  the migration URL continues to use PostgreSQL directly.
- `auth_type=scram-sha-256`; the PgBouncer admin console uses a dedicated admin identity, not a
  runtime role.
- The image retains the upstream ISC license and release provenance in its build metadata.

## Success criteria

Measured after ramp-up, excluding the separately labelled timeout probe:

| metric                                          |                 calibration and soak target |
| ----------------------------------------------- | ------------------------------------------: |
| authenticated sessions                          |                            1,000 maintained |
| offered throughput                              |                               400–500 req/s |
| HTTP p50                                        |                                    ≤ 250 ms |
| HTTP p95                                        |                                     ≤ 1.5 s |
| HTTP p99                                        |                                       ≤ 3 s |
| 5xx responses                                   |                                      ≤ 0.1% |
| unexpected non-2xx responses, including `429`   |                                      ≤ 0.1% |
| PostgreSQL `pg_stat_activity` total             |                                  ≤ 100 peak |
| PgBouncer database backends                     |                                   ≤ 80 peak |
| PgBouncer `cl_waiting`                          |       0 in at least 95% of 5-second samples |
| PgBouncer `maxwait`                             | ≤ 50 ms in at least 95% of 5-second samples |
| `too many clients` / SQLSTATE 53300             |                                           0 |
| process RSS growth from minute 15 to minute 120 |                                       < 10% |

The timeout probe connects as each real role, verifies `SHOW statement_timeout` and
`SHOW idle_in_transaction_session_timeout`, then runs `pg_sleep` outside the timed workload.
SQLSTATE `57014` must occur within the configured bound. Query text and credentials are never
written to the report.

## Observability contract

The monitor samples every five seconds through credentials separate from load traffic:

- PostgreSQL: total/active/idle-in-transaction connections and SQLSTATE 53300/57014 counts;
- PgBouncer admin console: `SHOW POOLS` and `SHOW STATS`, including `sv_active`, `sv_idle`,
  `cl_waiting`, and `maxwait`/`maxwait_us`;
- app: status counts and latency histogram by route;
- host/container: CPU, RSS, restart count, and open file descriptors.

The runner must handle `SIGINT`/`SIGTERM`, stop scheduling new requests, wait up to 30 seconds for
in-flight requests, close database clients, and still write a partial report marked `aborted`.

## Non-goals

- Query/index optimization and pagination changes.
- High availability, failover, or app replica/load-balancer work.
- Hiding insufficient capacity behind broader rate limits.
- Federated-source or AI-provider capacity certification.
- Running a destructive or surprise load test against production.
- Claiming the 30-second CI smoke proves the two-hour requirement.

## Resolved edge cases

- The two platform client exports are consolidated before sizing; aliases (`publicDb`,
  `accountDb`) remain aliases and do not count as additional pools.
- A PgBouncer outage fails readiness and deployment smoke checks; the app does not silently switch
  to the direct database URL.
- Pooler and direct URLs are distinct in reports and are redacted before serialization.
- Intentional timeout-probe failures are excluded from the user error-rate numerator but reported
  separately.
- Load fixtures are created only on loopback or an explicitly named disposable database. The seed
  refuses the production DB marker and never reuses `scripts/db/seed-test-users.ts`.
- A baseline crash is valid evidence and does not block hardening; post-change results are judged
  against the explicit targets, not an impossible “every metric must beat baseline” rule.

## References

- [PgBouncer configuration](https://www.pgbouncer.org/config.html)
- [PgBouncer features and transaction-pooling limits](https://www.pgbouncer.org/features.html)
- [PgBouncer 1.25.2 release](https://github.com/pgbouncer/pgbouncer/releases/tag/pgbouncer_1_25_2)
- `node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/README.md` (supported client options)
