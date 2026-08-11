# Load testing and the PgBouncer rollout

Everything needed to run a load test, and everything needed to put a pooler in front of production
without finding out the hard way. Plan `55-load-1000-concurrent-users` is the source; this file is the
operator's copy.

## What the harness is, in one pass

| Piece | File | What it does |
|---|---|---|
| Safety | [`scripts/load/safety.ts`](../../scripts/load/safety.ts) | Three refusals between a run and somebody's production database |
| Fixtures | [`scripts/load/seed.ts`](../../scripts/load/seed.ts), [`cleanup.ts`](../../scripts/load/cleanup.ts) | 1,000 users and ~33,000 rows in; every run-scoped row out |
| Runner | [`scripts/load/runner.ts`](../../scripts/load/runner.ts), [`auth.ts`](../../scripts/load/auth.ts) | Closed-loop virtual users, preflight, drain, report |
| Monitor | [`scripts/load/monitor.ts`](../../scripts/load/monitor.ts), [`sql.ts`](../../scripts/load/sql.ts) | PostgreSQL activity, `SHOW POOLS`/`SHOW STATS`, container gauges, every 5s |
| Report | [`scripts/load/report.ts`](../../scripts/load/report.ts) | Thresholds, verdict, exit code, and a credential scan before anything is written |
| Smoke | [`scripts/load/smoke.ts`](../../scripts/load/smoke.ts) | The whole thing end to end, small enough for CI |
| Pooler | [`docker/pgbouncer/`](../../docker/pgbouncer/) | Pinned PgBouncer 1.25.2, non-root, auth file in tmpfs |

```bash
pnpm test:load:smoke
```

## Reading a report without being misled

Three verdicts, three meanings, three exit codes.

- **`pass` (0)** — every threshold met, for the topology named in the report's `pool mode` line.
- **`fail` (2)** — a threshold was breached. The report prints *every* failed check, not the first.
- **`aborted` (3)** — the run never reached steady state, so **no thresholds were evaluated at all**.
  An aborted run is not a capacity result. Treating it as one sends somebody looking for a slow query
  that may not exist. The reason is printed above the tables.

Two things a green report does not say on its own:

- A `null` in the peaks block means *nothing was observed*, not zero. A direct run has no PgBouncer
  numbers; a run outside compose has no container numbers. This distinction exists because a monitor
  whose every query failed once produced `PostgreSQL connections: 0 peak ✅` — a threshold satisfied by
  the absence of data. The runner now aborts when every sample failed, and the report keeps `null`
  rather than substituting `0`.
- Percentiles are ±1 ms, from 1 ms histogram buckets. Samples are not retained, because retaining
  3.2 million of them over a two-hour soak would consume the RSS budget the run is measuring.

## Running a load test

### 1. A disposable database, and only a disposable database

`safety.ts` refuses unless **all three** hold. Each catches a different mistake and any one alone
leaves a real path open:

- the database name starts with `builderhunt_load_test` — catches the right host and the wrong
  database, which is the likeliest error, because `DATABASE_URL` on a developer machine is the dev
  database;
- the host is loopback, unless `LOAD_DISPOSABLE_DATABASE=true` — catches the right name on a remote
  host, which is how a staging cluster acquires a thousand fixture users;
- no production marker (`prod`, `production`, `live`, `coolify`, `hetzner`) appears anywhere in the
  URL, including the username and database name — and this one applies even with the remote flag set.

Errors never echo the URL, because it carries a password.

### 2. Seed, run, clean up

```bash
LOAD_DATABASE_URL=postgresql://…@127.0.0.1:5432/builderhunt_load_test_1 pnpm load:seed
LOAD_MANIFEST=tests/artifacts/load/<runId>-fixtures.json pnpm load:test:baseline
LOAD_DATABASE_URL=… LOAD_RUN_ID=<runId> pnpm load:cleanup
```

Every fixture row carries the run id **inside its primary key**, and cleanup deletes by that prefix
rather than truncating. That matters when two runs share a disposable host — a retried certification
alongside a running baseline — because `truncate` would take the other run's fixture out from under it
and the failure would surface as unexplained 500s nobody would connect back to a cleanup.

`pnpm load:verify-fixtures` proves the round trip against a database it creates and drops itself:
exactly 1,000 login-capable users in, every run-scoped count back to zero.

### 3. The sign-in ceiling, which is not negotiable from a script

`better-auth.ts` caps `/sign-in/email` at **20 per minute per IP**, and every virtual user signs in
from one host. A 1,000-user startup therefore hits that wall by design, and the runner writes an
`aborted` report quoting the limit rather than a `fail` — `aborted` says the run proved nothing, while
`fail` would say the product cannot do this, which is untrue.

A run at that size needs the limit raised **on the disposable load host, by whoever owns it**. That is
an operator decision about a throwaway environment. Do not raise it to make a test pass: the CI smoke
runs 15 users for exactly this reason.

### 4. The connection budget

One app process caps its five pools at 12/4/4/3/3 — **26 connections** — see
[`pool-options.ts`](../../src/shared/lib/db/pool-options.ts). Against `max_connections=120` and
PgBouncer's `max_db_connections=80`, four processes stay inside the budget with room for the pooler,
the migration connection and a monitor.

`LOAD_POOL_MAX_RUNTIME` and friends override a single pool. **Production refuses an unusable value at
startup** — `postgres.js` reads a `NaN` max as *unbounded*, so a typo does not fail where it was
written; it fails hours later as `too many clients already` in an unrelated request. Outside
production the same typo warns and uses the default.

Each pool sets `application_name` to `builderhunt_<role>`, which is the only way to tell them apart
from the database side:

```sql
select application_name, count(*) from pg_stat_activity group by 1 order by 2 desc;
```

## The local pooled topology

```bash
docker compose --profile standalone --profile load up -d pgbouncer
pnpm load:pooler:preflight
```

Both profiles are required: `pgbouncer` depends on `db`, and Compose does not pull in a dependency
from a profile you did not ask for.

The preflight is 13 checks — five roles reaching `SELECT 1` through 6432, `SHOW CONFIG` reporting
transaction mode with 12/4/80/500, the migration URL on the direct port, `max_connections >= 120`, and
the container healthy. It reads the caps **from the running pooler**, not from the committed ini,
because a file in the repository is not evidence about a running container. That distinction is not
theoretical: the ini was correct while the container could not start at all, because the tmpfs was
mounted over the directory holding it.

`tests/e2e/api/pgbouncer-compatibility.spec.ts` covers what pooling can actually break — the five role
timeouts *enforced* through the pooler, no session-state leak across checkouts, sign-in, a
tenant-scoped read and a cross-tenant read that is refused. It skips with a reason when PgBouncer is
not running.

## Rolling PgBouncer out on Coolify

### What gets created

A **separate service on the private network**, not a container beside the app. The app reaches it by
service name; nothing about the pooler is published publicly. The database stays reachable directly on
5432 for migrations and monitoring — see below for why that is not optional.

Inputs, all as Coolify environment variables on the pooler service:

| Variable | Purpose |
|---|---|
| `BUILDERHUNT_APP_PASSWORD` | SCRAM verifier source for `builderhunt_app` |
| `BUILDERHUNT_AUTH_PASSWORD` | …`builderhunt_auth` |
| `BUILDERHUNT_WORKER_PASSWORD` | …`builderhunt_worker` |
| `BUILDERHUNT_PLATFORM_PASSWORD` | …`builderhunt_platform` |
| `BUILDERHUNT_CAPABILITY_PASSWORD` | …`builderhunt_capability` |
| `PGBOUNCER_ADMIN_PASSWORD` | `SHOW POOLS` / `SHOW STATS` / `SHOW CONFIG` only |

**Generated auth files live only in tmpfs.** `entrypoint.sh` writes `userlist.txt` at 0600 into
`/run/pgbouncer`, which is a memory-backed mount: the file exists for the life of the container and
dies with it. A `COPY userlist.txt` would publish five database passwords to anyone who can read the
image, permanently. Nothing writes it to a volume, and the image contains no such layer — verified by
inspection, and worth re-verifying after any Dockerfile change.

Note that `/run/pgbouncer` and `/etc/pgbouncer` are deliberately different directories. Runtime state
and baked configuration cannot share one mount point.

### The order, and the one URL that must not move

1. Deploy the pooler service. Wait for its healthcheck.
2. Run the preflight against it, redacted — five roles, `SHOW CONFIG`, the caps.
3. Point the app's **runtime** URLs at the pooler: `DATABASE_URL`, `DATABASE_AUTH_URL`,
   `DATABASE_WORKER_URL`, `DATABASE_PLATFORM_URL`, `DATABASE_CAPABILITY_URL`.
4. Leave `DATABASE_MIGRATION_URL` **direct on 5432**. A migration runs many statements in one
   transaction and takes advisory locks; under transaction pooling it is handed a different backend
   between statements and the locks are released underneath it. A half-applied migration is the worst
   outcome in this document.
5. Redeploy the app. Watch the pooler's `SHOW POOLS` for `cl_waiting` while traffic returns.
6. Run the low-rate smoke — 15 users, 30 seconds — against the pooled topology and read the report.

### Metrics to watch, and stop conditions

| Signal | Where | Stop if |
|---|---|---|
| `cl_waiting` | `SHOW POOLS` | above 0 in more than 5% of 5-second samples |
| `maxwait` + `maxwait_us` | `SHOW POOLS` | above 50 ms in more than 5% of samples |
| server backends | `SHOW POOLS`, summed | above 80 |
| PostgreSQL connections | `pg_stat_activity` | above 100 |
| 5xx ratio | app logs, report | above 0.1% |
| `prepared statement … does not exist` | app logs | **any occurrence** — `prepare: false` regressed |

`maxwait` is whole seconds and `maxwait_us` is the microsecond remainder. Reading `maxwait` alone
reports `0` for every wait under a second, and the threshold is 50 ms — so that reading would pass for
every value it exists to catch.

### Rollback

Point the five runtime URLs back at 5432 and redeploy. That is the whole procedure: the pooler holds no
state the application needs, no schema changed, and `DATABASE_MIGRATION_URL` never moved. Stop the
pooler service afterwards if it is not being reintroduced.

### Production load runs require explicit approval

A load run against production is a deliberate, approved act with a named owner and a window, not a
troubleshooting step. `safety.ts` refuses a production marker in a URL, and that refusal is not to be
worked around — the fixtures write a thousand users and the cleanup deletes rows. See
[`deploy-runbook.md`](./deploy-runbook.md) for how release-time decisions are recorded.

## What this harness does not cover

- **SQLSTATE 57014 counts.** Not observable from SQL — no catalog view carries them — so a sampled
  figure would have to come from the server log. The property they would evidence is proven directly
  and more strongly by `pnpm run test:db-role-timeouts` and
  `tests/e2e/api/database-role-timeouts.spec.ts`, which *cause* a 57014 through each role and assert on
  it. **53300** is covered, counted from the monitor's own refused connection.
- **Federated search.** Kept out of the route mix on purpose: third-party latency is not PostgreSQL
  capacity, and folding it in would let a slow upstream fail a database certification or a fast one
  hide a database problem.
- **The certification itself.** The 10-minute baseline, the pooled calibration and the two-hour soak
  are cost-bearing runs on an isolated host. The harness is ready for them; running them is a separate,
  approved step, and the plan stays open until one passes.
