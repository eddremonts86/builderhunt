# Load testing and the PgBouncer rollout

Everything needed to run a load test, and everything needed to put a pooler in front of production
without finding out the hard way. Plan `55-load-1000-concurrent-users` is the source; this file is the
operator's copy.

## What the harness is, in one pass

| Piece | File | What it does |
|---|---|---|
| Safety | [`scripts/load/safety.ts`](../../scripts/load/safety.ts) | Three refusals between a run and an unintended database, plus one deliberate way through |
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

Production is reachable, but only down a separate and deliberate path — see
[Load-testing production itself](#load-testing-production-itself). Two variables, one of them a typed
sentence, and a mandatory fixture password.

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

**Above that ceiling the runner mints sessions instead of earning them.** Give it
`fixtureDatabaseUrl` and any profile over 20 users skips `/sign-in/email` entirely: one
`auth_sessions` row per fixture user, and a cookie built with better-auth's own `generateRandomString`
and `makeSignature`. Below the ceiling the real sign-in stays, because it exercises a path the run
would otherwise never touch and it costs seconds at that size.

Nothing about the limit changes. It is not raised, not bypassed on the request path, and a run without
a fixture database URL still aborts against it exactly as before.

The trade is that a large run no longer exercises `/sign-in/email`. That is a decision, not an
oversight, and it belongs in the certification report: this plan's spec already says rate limiting is
not part of the capacity fix, and sign-in is startup rather than the measured workload.

### 3a. The cookie format is re-proved on every run, and here is why

`mintSessions` does not assume the cookie's name or its signature format. `resolveSessionCookieFormat`
performs **one** real sign-in — far under 20/min — reads the name off the `set-cookie`, and re-signs
that same token to check it produces better-auth's signature byte for byte. It refuses the run if not.

That check earned its place the first time it ran. `better-call`'s `signCookieValue` applies
`encodeURIComponent` **inside the signing helper**, not in the serializer, so base64 `+` and `=` reach
the header as `%2B` and `%3D`. Reading `_serialize` alone says the value is not encoded — true, and
misleading. Without the byte-for-byte check the harness would have passed its own tests and then sent
400,000 anonymous requests, and the report would have described the latency of the signed-out
application: fast numbers answering a question nobody asked.

The cookie *name* is equally not assumed. It is better-auth's default only because no `cookiePrefix`
or `useSecureCookies` is configured; both would move it, and so would an upgrade.

### 3b. Two ways the runner cannot reach an app that is running fine

Both were found on 2026-08-18 setting up the first smoke through the minting path, and both read as
"the app will not start" while the app is serving perfectly.

**The dev server binds IPv6 only.** `vite dev` listens on `[::1]`, and the runner's default base URL
is `http://127.0.0.1:3000` — IPv4. `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows the listener, `curl`
against `127.0.0.1` gets nothing, and the run dies with `fetch failed` after the minting log line.
Use `http://localhost:<port>`, which resolves to `::1` first on macOS.

```
localhost:3013   -> 200
[::1]:3013       -> 200
127.0.0.1:3013   -> refused
```

**`LOAD_BASE_URL` must equal the app's own `APP_URL`.** The probe sign-in sends `Origin`, because a
browser does and better-auth validates it — so a mismatched port or host answers
`403 INVALID_ORIGIN`, which is the application behaving correctly and looks like a credential problem.
Against production the two match naturally (`https://builderhunt.dev`); they diverge the moment
somebody points the runner at loopback "to go faster".

With both aligned, a 25-user smoke through the minting path passes end to end: 25 minted, preflight
green on all five routes, p50 35 ms / p95 225 ms, zero 5xx.

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

## Load-testing production itself

The decision on this product is to certify against **production**, not against a rented lookalike: the real
Coolify private network, the real pooler and the real host only exist there, and a 4-vCPU box somewhere else
measures a different system. During beta there are no real users and the database is expendable, which is
what makes it defensible.

> **Refined 2026-08-14 — the certification does not use the sentinel below.** "Against production" turned
> out to mean the *host, pooler and PostgreSQL instance*, not the `builderhunt` database. The fixture goes
> in a disposable `builderhunt_load_test_*` database on that same instance, with the app repointed at it
> for the window, so the certification never targets the production database and
> `LOAD_TARGET_PRODUCTION` is never set. It needs `LOAD_DISPOSABLE_DATABASE=true` alone — the name-prefix
> and production-marker refusals still stand on top of it. See *The certification window, step by step*.
>
> The rest of this section still applies to the case it was written for: deliberately pointing the fixture
> at the production database itself. Nothing in the plan now does that, and the paragraph below on a
> thousand live logins is the reason the arrangement changed.

It is still not something a script should be able to do by accident, so the guard takes **two** deliberate
variables and refuses without either:

```bash
export LOAD_TARGET_PRODUCTION=i-am-seeding-and-deleting-rows-in-production
export LOAD_FIXTURE_PASSWORD="$(openssl rand -hex 24)"
```

The sentinel is a sentence rather than `true` because `LOAD_DISPOSABLE_DATABASE=true` is one keystroke away
from being left set in a shell that later runs something else. With it, the disposable-name-prefix and
production-marker checks yield; the loopback rule still needs `LOAD_DISPOSABLE_DATABASE=true` on top.

**`LOAD_FIXTURE_PASSWORD` is not optional off loopback, and that is the point.** `seed.ts` hashes one
password for a thousand accounts, and the repository's default is a constant anybody can read. On loopback
those accounts are unreachable. On production they are a thousand live logins on a public site with a
password published in git — and if a run aborts before cleanup, they stay. This is an access problem, not a
data problem, so it is refused rather than warned about.

Keep the run id. Cleanup is scoped to it and is the only thing that removes those accounts:

```bash
LOAD_DATABASE_URL=… LOAD_RUN_ID=load-<stamp>-<suffix> pnpm load:cleanup
```

### The sign-in ceiling is the practical limit, and production is where it matters most

`/sign-in/email` allows 20 per minute per IP. A thousand virtual users signing in from one machine therefore
needs about 53 minutes of paced startup, or the limit raised for the window. Raising it on a public site
removes a real brute-force guard, so the paced option is the one that costs nothing but time — and a
two-hour soak can afford an hour of ramp-in.

> ⛔ **Neither lever exists, as of 2026-08-14 — and the fix is to stop needing them.** This section used
> to end "either way it is an operator decision with a window", which assumed two knobs and there are
> none.
>
> - **Pacing is not implemented.** Sign-in is a *separate phase before* the ramp, so
>   `stages.rampSeconds` does not govern it — that only staggers when already-authenticated sessions
>   begin issuing requests. `signInAll` takes `baseUrl`, `users`, `concurrency`, `timeoutMs` and
>   `onProgress`; `concurrency` bounds parallelism, not rate. `runner.ts` calls it with a hardcoded
>   `SIGN_IN_CONCURRENCY = 8` and no delay, so eight workers exhaust 20/minute in seconds and
>   `signInAll` aborts at the first `429` — deliberately, because continuing would produce a run with
>   an arbitrary subset of users.
> - **Raising the cap is not configuration.** `'/sign-in/email': { window: 60, max: 20 }` is a literal
>   in `better-auth.ts`, not read from the environment, so that route needs a code change and a
>   redeploy of the app whose capacity is being measured.
>
> So a 1,000-user run cannot start today, against any target.
>
> **The chosen fix is neither lever: mint the sessions instead of earning them.** `auth_sessions` is
> a flat table (`id`, `user_id`, `token`, `expires_at`, `active_organization_id`), the cookie is
> `${token}.${signature}` — `tests/e2e/auth-and-sessions.spec.ts` documents that format while
> expiring a session by its token — and `better-auth/crypto` exports both `generateRandomString` and
> `makeSignature`, so the harness can build a valid cookie with the library's own primitives rather
> than a reimplementation that could drift. Sign-in stops being a rate-limited phase at all: 53
> minutes per run becomes seconds, and no protection is touched.
>
> The cost is that a run no longer exercises `/sign-in/email`, which is acceptable because this spec
> already says rate limiting is not part of the capacity fix and sign-in is startup, not the measured
> workload. It is a decision, and it belongs in the certification report.
>
> **Landed 2026-08-16** as `mintSessions` / `resolveSessionCookieFormat` in `scripts/load/auth.ts`,
> with `tests/unit/scripts/load/auth-mint.test.ts` minting a thousand sessions against a disposable
> database and `tests/e2e/load-minted-session.spec.ts` proving the real server accepts one and refuses
> a cookie signed with the wrong secret. See §3a above for the encoding the byte-for-byte check
> caught.

### Production load runs still require explicit approval

A load run against production is a deliberate, approved act with a named owner and a window, not a
troubleshooting step. `safety.ts` refuses a production marker in a URL, and that refusal is not to be
worked around — the fixtures write a thousand users and the cleanup deletes rows. See
[`deploy-runbook.md`](./deploy-runbook.md) for how release-time decisions are recorded.

### The certification window, step by step

Written 2026-08-14 for the operator running
[`plans/phase-1/55-load-1000-concurrent-users`](../../plans/phase-1/55-load-1000-concurrent-users/tasks.md)
to completion. **It does not run today** — the two harness tasks at the top of that plan's Phase 1
have to land first. Everything below is the order once they have.

Budget about three hours: sessions are minted rather than signed in, so startup is seconds, not the
53 minutes an earlier draft of this section budgeted. Ten minutes each for baseline and calibration,
two hours of soak, and the repointing either side.

**The fixture never touches `builderhunt`.** It lives in a throwaway database on the same PostgreSQL
instance, and the app is repointed at it for the window. Everything being certified is unchanged —
same host, same CPU and disk, same pooler, same instance-wide `max_connections`, and the
`* = host=…` wildcard in `pgbouncer.ini` already forwards whatever database a client asks for. What
changes is that cleanup is a `DROP DATABASE`, so an aborted run cannot leave a thousand accounts
sharing one password on the live site.

**Before the window**

1. Fresh database backup of `builderhunt`, verified restorable — not just taken.
   `host-maintenance.md` has the restore drill. The load never writes to it, but the app is being
   redeployed twice and PostgreSQL is being restarted for `max_connections`.
2. Agree the window and name its owner. This is the approval `safety.ts` refuses without.
3. Create the load database on the production instance and migrate it to head. The name **must**
   start with `builderhunt_load_test` — that prefix is one of the three refusals, not a convention.
4. Environment. `LOAD_DISPOSABLE_DATABASE=true` is what permits a non-loopback host; the name-prefix
   and production-marker refusals still apply on top of it.
   ```bash
   export LOAD_DISPOSABLE_DATABASE=true
   export LOAD_FIXTURE_PASSWORD="$(openssl rand -hex 24)"   # never reuse, never the repo default
   export LOAD_BASE_URL=https://builderhunt.dev
   ```
5. Seed, and keep the run id and manifest path:
   ```bash
   LOAD_DATABASE_URL=postgresql://…/builderhunt_load_test_1 pnpm load:seed
   ```
6. Repoint the app's five runtime role URLs at the load database and redeploy.
   `DATABASE_MIGRATION_URL` stays on `builderhunt`, direct on 5432.

**The three runs**

| # | Stage | Command | Reads |
|---|---|---|---|
| 1 | Baseline | `LOAD_MANIFEST=… pnpm load:test:baseline` | `pool_mode=direct`, 10 min |
| 2 | Deploy the pooler, then calibrate | rollout steps 1–2 above, then `pnpm load:pooler:preflight`, then the runner with `--pooled` | `pool_mode=transaction`, 10 min |
| 3 | Soak | the runner with `--pooled --seconds=7200` | 120 complete steady minutes |

Between 1 and 2, follow *The order, and the one URL that must not move* above. `DATABASE_MIGRATION_URL`
stays direct on 5432 through all of it.

**The runner's flags, and what each is allowed to change**

| Flag | Changes | Deliberately does *not* change |
|---|---|---|
| `--seconds=N` | `steadySeconds` | the ramp, the offered-rate window, the user count |
| `--users=N` | `users`, and widens `offeredRatePerSecond` to `{0, ∞}` | the ramp, the steady window |
| `--ramp=N` | `rampSeconds` | everything else |
| `--smoke` | the whole profile, to `SMOKE_LOAD_CONFIG` | — |
| `--pooled` | the topology the runner reports | the contract |

`--users` widens the offered-rate window because the rate is derived as
`users / (thinkTime + averageJitter)` — 25 users cannot offer 400 req/s, and asserting they do is
arithmetic rather than capacity. `--seconds` does not, because a thousand users offer the same rate for
two hours as for ten minutes.

Until 2026-08-16 `--seconds` did both: it collapsed the ramp to two seconds *and* widened the window.
A `--seconds=7200` certification would therefore have reported a two-second ramp and **no offered-rate
check at all**, and 400–500 req/s is one of the spec's own success criteria — the report would have
read `pass` without evaluating it. Asserted now in
`tests/unit/scripts/load/runner-config.test.ts`.

**Watch these, and stop if any trips**

The table under *Metrics to watch, and stop conditions* is the live list. The two that end a run
immediately rather than being noted: any `prepared statement … does not exist` in the app logs
(`prepare: false` has regressed), and any SQLSTATE 53300.

**Rollback**, at any point: point the five runtime URLs back at `builderhunt` on 5432 and redeploy.
That single step both leaves the pooler and abandons the load database, so it is also the abort
procedure — there is no ordering to get wrong under pressure. The pooler holds no state the app
needs and no schema changed.

**After the window, in this order**

1. **Repoint the app back at `builderhunt` and redeploy first**, before anything else. Until that
   lands, the live site is serving the load fixture.
2. Drop the load database. That is the cleanup — `pnpm load:cleanup` exists for the case where the
   fixture shares a database with other rows, which is exactly the case this arrangement removes.
   Then confirm no `builderhunt_load_test%` database remains: a thousand accounts sharing one
   password is an access problem, and one left behind on the production instance is still reachable
   by anything that can reach that instance.
3. Write the report to `docs/operations/load-certification-<date>.md` with the raw artifact id, and
   state in it that sessions were minted rather than signed in, so `/sign-in/email` was not part of
   the measured workload. A missed threshold leaves the plan task open. Do not close the plan from
   the calibration.

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
