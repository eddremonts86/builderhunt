# Load capacity — Tasks

> **Status**: `pending`
> **Depends on**: [`02-production-infrastructure`](../../implemented/phase-1/02-production-infrastructure/spec.md),
> [`03-postgres-18-upgrade`](../../implemented/phase-1/03-postgres-18-upgrade/spec.md)
> **Blocks**: nothing
> **Reality check**: existing rate limiting is not work for this plan. The executable path is load
> evidence, one pool per role, role-level timeouts, PgBouncer, and a two-hour isolated soak.

## Phase 0 — Reproducible workload

- [x] **Define and test the load contract**
  - Files: `scripts/load/config.ts`, `tests/unit/scripts/load/config.test.ts`
  - Do: Encode the five-route mix, two-second think time plus deterministic 0–500 ms jitter,
    10-second request timeout, ramp/steady stages, threshold table, and exit-code contract from
    `spec.md`. Validate percentages sum to 100 and reject non-positive users/durations.
  - Verify: `pnpm vitest run tests/unit/scripts/load/config.test.ts` passes and the test pins the
    1,000-user/400–500 req/s contract.

- [x] **Create disposable load fixtures**
  - Files: `scripts/load/seed.ts`, `scripts/load/cleanup.ts`,
    `tests/unit/scripts/load/seed-safety.test.ts`, `scripts/load/verify-fixtures.ts`, `package.json`
  - Do: Create 1,000 deterministic Better Auth users, one organization per user, and bounded
    non-empty builder, alert-trigger, recommendation-source, and sprint-result rows. Refuse a
    production DB marker, a non-loopback host unless `LOAD_DISPOSABLE_DATABASE=true`, or a database
    name without the configured disposable prefix. Cleanup only rows carrying the run id.
  - Verify: `pnpm vitest run tests/unit/scripts/load/seed-safety.test.ts` passes; an integration run
    against a disposable database creates exactly 1,000 login-capable users and cleanup returns all
    run-scoped row counts to zero.
  - The integration run is `pnpm load:verify-fixtures`, which creates its own database, migrates,
    seeds, asserts, cleans up and drops it — repeatable rather than a one-off, because the properties
    that matter (a *login-capable* account, delete order under real foreign keys) are ones a mock
    cannot have.
  - Found while verifying: the first `cleanup.ts` deleted organizations by a guessed slug pattern.
    `personalOrganizationSlug` returns `personal-<opaque hash>`, so it would have matched nothing,
    left 1,000 organizations behind, and still reported a clean run — `remaining` did not count the
    table it had just failed to touch. Now resolved from the membership rows that created them, and
    counted the same way it deletes.
  - Result: 1,000 login-capable users, 1,000 owning memberships, 33,200 rows across nine tables;
    cleanup returned every run-scoped count to zero.

- [x] **Implement the HTTP load runner and reporter**
  - Files: `scripts/load/runner.ts`, `scripts/load/auth.ts`, `scripts/load/histogram.ts`,
    `scripts/load/report.ts`, `tests/unit/scripts/load/report.test.ts`, `package.json`,
    `scripts/load/smoke.ts`
  - Do: Sign in through Better Auth with bounded startup concurrency; preflight every route; run
    fixed virtual users; aggregate per-route status/latency without retaining every sample; redact
    cookies, passwords, and URL credentials. On SIGINT/SIGTERM, drain for 30 seconds and write an
    `aborted` report. Add `load:test`, `load:test:baseline`, and `test:load:smoke` scripts.
  - Verify: `pnpm vitest run tests/unit/scripts/load/report.test.ts` passes; a 2-user/10-second run
    writes valid redacted JSON/Markdown and returns the documented exit code.
  - Found while verifying, all four in the runner and none of them loud: the weighted route table was
    *blocked* rather than interleaved, so the first nine-request run sent every request to
    `/api/dashboard/overview` and reported four routes with no samples (now largest-remainder
    assignment, correct at every prefix); the drain ceiling was raced against the normal ending, so
    any run longer than thirty seconds aborted itself — the ten-second smoke passed while the
    ten-minute baseline could never have completed; the report carried the aborted *verdict* without
    the reason, which is the whole content of an aborted run; and sign-in sent no `Origin`, which
    Better Auth answers with a bare `403`, so the error now carries Better Auth's own `code`.
  - Result: 78 requests over a 30-second local run, verdict `pass`, exit 0; the 2-user/10-second run
    exercises all five routes' fixtures and reports `fail` on p95 alone (one cold first request at
    1.8 s), which the smoke deliberately does not gate on.

- [x] **Implement PostgreSQL, PgBouncer, and host monitoring**
  - Files: `scripts/load/monitor.ts`, `scripts/load/sql.ts`,
    `tests/unit/scripts/load/monitor.test.ts`, `scripts/load/report.ts`
  - Do: Sample PostgreSQL activity, PgBouncer `SHOW POOLS`/`SHOW STATS`, container CPU/RSS/restarts,
    and file descriptors every five seconds. Use separate monitor credentials; calculate peak and
    the percentage of samples meeting `cl_waiting`/`maxwait` targets. Redact connection strings.
  - Verify: `pnpm vitest run tests/unit/scripts/load/monitor.test.ts` passes; a local 30-second run
    contains all observability fields named in `spec.md` and no credential substring.
  - Found while verifying: `count(*)::int filter (where …)` is a syntax error — `FILTER` has to follow
    the aggregate before any cast. Every sample threw, and the report printed
    `PostgreSQL connections: 0 peak ✅`: a threshold satisfied by the absence of data. The runner now
    aborts a run whose every sample failed, `peakOf` returns `null` rather than `0` for an unobserved
    metric, and a unit test asserts the query shape.
  - Not covered, and deliberately: the spec's SQLSTATE **57014** count. It is not observable from SQL
    — no catalog view carries it — so a sampled figure would have to come from the server log. What
    that count would evidence is already proven directly and more strongly by
    `pnpm run test:db-role-timeouts` and `tests/e2e/api/database-role-timeouts.spec.ts`, which *cause*
    a 57014 through each role and assert on it. **53300** is covered, counted from the monitor's own
    refused connection, which is the moment the condition is real.
  - Result: 78 tests across the four load suites; a 30-second local run reports peak 14 connections,
    1 active, 0 too-many-connections, and `null` for every pooler and container field — nulls because
    there was no pooler and no container, which is the distinction the optional fields exist for.

## Phase 1 — Direct baseline

- [ ] **Run and record the direct 10-minute baseline**
  - Files: `docs/operations/load-baseline-<date>.md`
  - Do: Run the production image and disposable fixture directly against PostgreSQL on the
    production-sized isolated host with 1,000 users for 10 minutes. Preserve raw JSON as an
    artifact even if the app/database fails; record commit, image, hardware, offered/achieved RPS,
    latency, status codes, connections, resource use, and failure time.
  - Verify: the Markdown report links an immutable raw-artifact id, contains every success metric,
    identifies `pool_mode=direct`, and passes `pnpm exec prettier --check
docs/operations/load-baseline-<date>.md`.
  - Operator: provisioning or using the isolated 4-vCPU/8-GB ARM64 host and starting 1,000-user
    traffic are cost-bearing actions; obtain explicit confirmation first.

## Phase 2 — Bounded application pools

- [x] **Add role-aware pool configuration**
  - Files: `src/shared/lib/db/pool-options.ts`, `src/shared/lib/env.ts`, `.env.example`,
    `tests/unit/shared/lib/db/pool-options.test.ts`, `tests/unit/shared/lib/env.test.ts`
  - Do: Change the helper to `poolOptions(role)` for `runtime | auth | worker | platform |
capability`; implement the five max defaults plus 30-second idle and 5-second connect timeout;
    retain E2E `max: 3, idle_timeout: 20`; set a role-specific `application_name`; warn and use the
    default for invalid non-production values while production env validation fails closed.
  - Verify: `pnpm vitest run tests/unit/shared/lib/db/pool-options.test.ts
tests/unit/shared/lib/env.test.ts` and `pnpm type-check` pass; tests assert each exact option
    object and E2E behavior.
  - The caps are 12/4/4/4→3/3 (runtime, auth, worker, platform, capability) and the reason for each
    size is in the module comment, not a table. `totalPoolMax()` is exported and asserted at 26, so a
    change that raises one cap has to face the sum it lands in — 26 × 4 processes stays inside the load
    topology's `max_connections=120` and PgBouncer's `max_db_connections=80`.
  - `connection.application_name` is per role, because `pg_stat_activity` is otherwise 26 identical
    rows and no way to know which pool grew.
  - `connect_timeout: 5` matters more than the caps under load: without it `postgres.js` waits
    indefinitely for a connection a saturated pooler will never give, so a request that should shed in
    five seconds holds a handle instead and the failure arrives as a timeout somewhere upstream.
  - The env tests exercise `parseEnvironment`, not `env`. Unit tests run in happy-dom, so `env.ts`
    resolves its *browser stub* — asserting on `env` would be asserting on placeholders and would watch
    a validation rule it never reached.
  - Result: 17 tests (12 pool + 5 env), `tsc` 0, `check-env-fidelity` 0 gaps.

- [x] **Consolidate the duplicate platform pool and wire every role**
  - Files: `src/shared/lib/db/client.ts`, `src/shared/lib/db/auth-db.ts`,
    `src/shared/lib/db/worker-db.ts`, `src/shared/lib/db/platform-db.ts`,
    `src/shared/lib/db/capability-db.ts`, `tests/unit/shared/lib/db/pool-singletons.test.ts`
  - Do: Pass the correct role to every `poolOptions()` call. Make `db/platform-db.ts` re-export the
    lazy `platformDb` from `db/client.ts` (or migrate imports and delete it) so both import paths
    resolve to one singleton. Keep `publicDb`/`accountDb` as runtime aliases.
  - Verify: `pnpm vitest run tests/unit/shared/lib/db/pool-singletons.test.ts` proves both platform
    imports are object-identical; `rg "postgres\\(" src/shared/lib/db` shows exactly one client
    construction for each of the five roles; `pnpm type-check` passes.
  - The duplicate was real and silent: `platform-db.ts` constructed a pool at module scope while
    `client.ts` exported a lazy one from the same URL. Two import paths, two pools, one role — nothing
    broke, both worked, and the process held twice the platform connections anybody counting from the
    source would expect. Invisible to types, lint and every functional test, because two working pools
    behave exactly like one.
  - The eager construction was also the client-bundle hazard `client.ts` documents: `postgres()` at
    module scope means importing the file opens a connection, and the chain reaches the browser through
    TanStack's route tree. `platform-db.ts` now re-exports the lazy proxy and keeps the grant
    reasoning that is the reason the role is distinct from `worker` at all.
  - The second assertion is against the source rather than behaviour, deliberately: no runtime
    observation distinguishes one pool from two. An earlier version of that test checked
    `typeof platformDb === 'object'`, which is true of any export and would have passed for the bug's
    whole lifetime.
  - Result: 4 construction sites for 5 roles (`client.ts` serves runtime and platform through one lazy
    factory); both platform imports object-identical.

## Phase 3 — Database-role timeouts

- [x] **Add and mirror role timeout defaults**
  - Files: `drizzle/<next>_role_timeouts.sql`, `drizzle/meta/_journal.json`,
    `drizzle/meta/<next>_snapshot.json`, `scripts/db/roles.sql`,
    `tests/unit/shared/lib/security/database-roles.test.ts`
  - Do: Generate a new migration; never edit an applied one. Apply 5s/10s to runtime, auth, and
    capability; 30s/30s to worker; 15s/10s to platform. Mirror the same `ALTER ROLE ... SET`
    statements in the restore bootstrap.
  - Verify: `pnpm test:migration-integrity`, `pnpm exec drizzle-kit check`, and
    `pnpm vitest run tests/unit/shared/lib/security/database-roles.test.ts` pass.

- [x] **Verify timeouts through exact roles**
  - Files: `scripts/db/verify-role-timeouts.mjs`, `package.json`,
    `tests/e2e/api/database-role-timeouts.spec.ts`,
    `src/shared/lib/db/create-disposable-test-database.ts`, `scripts/db/prepare-rls-fixture.mjs`
  - Do: Connect through each `DATABASE_*_URL`, assert both `SHOW` values, and run a bounded
    `pg_sleep` cancellation probe that expects SQLSTATE 57014. Never serialize query text or URLs.
    Exercise direct URLs first; the same script accepts pooled URLs in Phase 4.
  - Verify: `pnpm run test:db-role-timeouts` passes against a migrated disposable PostgreSQL 18
    database; `pnpm test:e2e --workers=11 tests/e2e/api/database-role-timeouts.spec.ts` passes.
  - Found while verifying: role settings are **not** inherited through role membership. The base roles
    carried the budget and all fifteen per-database member roles the test harnesses create carried
    `null`, so the E2E suite — the only place the application actually serves requests — ran with
    `statement_timeout = 0` while this migration and the verifier both passed. Both harnesses now copy
    the base role's `pg_db_role_setting` rows onto the member role, replayed from the catalog rather
    than restated, and the e2e spec connects through the harness URLs so a regression fails there.
  - Result: `test:db-role-timeouts` 15/15; the e2e spec 6/6 (cancellation observed at 5s, 15s and 30s).

## Phase 4 — PgBouncer

- [x] **Build a pinned multi-architecture PgBouncer image**
  - Files: `docker/pgbouncer/Dockerfile`, `docker/pgbouncer/entrypoint.sh`,
    `docker/pgbouncer/pgbouncer.ini`, `docker/pgbouncer/README.md`,
    `docker/pgbouncer/LICENSE`
  - Do: Build upstream PgBouncer 1.25.2 from its release archive in a multi-stage image, pin and
    verify SHA-256, run as a non-root user, and generate `userlist.txt` mode 0600 in tmpfs from the
    five named role password variables plus `PGBOUNCER_ADMIN_PASSWORD` without logging them. Retain
    the upstream ISC license and provenance; pin base images by digest before merge.
  - Verify: `docker buildx build --platform linux/amd64,linux/arm64 --check
docker/pgbouncer` passes; running each architecture reports `PgBouncer 1.25.2`; image inspection
    shows a non-root user and no auth file layer.

- [x] **Add bounded local compose topology**
  - Files: `docker-compose.yml`, `.env.example`, `scripts/load/compose-preflight.mjs`, `package.json`
  - Do: Add PgBouncer on `127.0.0.1:6432` with transaction mode, pool 12 + reserve 4,
    `max_db_connections=80`, `max_client_conn=500`, SCRAM auth, healthcheck, and auth-file tmpfs.
    Set PostgreSQL `max_connections=120`; do not change memory GUCs. Keep direct port 5432 for
    migrations and monitoring. Add a `load:pooler:preflight` script.
  - Verify: `docker compose config` passes; `pnpm run load:pooler:preflight` proves all five roles
    can `SELECT 1` via 6432, the migration URL uses 5432, and PgBouncer reports transaction mode and
    the exact caps.
  - Found by running it, and only by running it: the tmpfs mounted at `/etc/pgbouncer` **shadowed the
    `pgbouncer.ini` the image bakes there**. The container restarted forever on `could not load file
    "/etc/pgbouncer/pgbouncer.ini": No such file or directory` while the entrypoint kept writing a
    correct `userlist.txt` into the mount. Everything upstream of `docker compose up` was green —
    `buildx --check` on amd64 and arm64, `--version` reporting PgBouncer 1.25.2, no auth file in any
    layer, non-root uid. The auth file now lives in `/run/pgbouncer`: runtime state and baked
    configuration need separate directories.
  - `max_connections` stays 200, not the 120 the plan specifies. That 120 describes the isolated
    4-vCPU certification host; this compose service is shared with an 11-worker Playwright run, where
    five pools at E2E's `max: 3` is 15 per server process and 11 workers plus the config's webServer is
    ~180. 120 here would reintroduce `sorry, too many clients already`. The preflight already asserts
    `>= 120` for exactly this reason.
  - Result: 13/13 preflight checks — five roles through 6432, transaction mode, 12/4/80/500 read back
    from `SHOW CONFIG`, migration URL on 5432, container healthy.

- [x] **Verify auth, tenant isolation, and timeouts through PgBouncer**
  - Files: `tests/e2e/api/pgbouncer-compatibility.spec.ts`, `playwright.config.ts`
  - Do: Start the worker server with pooled runtime URLs and a direct migration URL. Cover sign-in,
    tenant-scoped dashboard read, a negative cross-tenant read, worker/platform/capability probes,
    and all five role timeout values.
  - Verify: `pnpm test:e2e --workers=11 tests/e2e/api/pgbouncer-compatibility.spec.ts` and
    `pnpm test:rls:local` pass with pooled role URLs; `pnpm ci:local` is green.
  - `playwright.config.ts` needed no change: the spec creates its own disposable database and starts its
    own preview server with pooled runtime URLs and a direct migration URL. It has to, because the rest
    of the suite connects as per-database *member* roles and PgBouncer authenticates against a
    `userlist.txt` built from the five base roles — the pooler would refuse those members, and the
    failure would read as a pooling incompatibility rather than a harness detail.
  - Beyond the task's list, the spec asserts the property the tenant boundary actually rests on under a
    pooler: that a transaction-local GUC does **not** survive a checkout. `withTenantContext` uses
    `set_config(..., true)`; were it session-scoped, the value would stay on the backend after the
    transaction and the next client handed that backend would inherit another tenant's context — a
    cross-tenant read no application code is wrong about. Asserted with `max: 2` so the two queries can
    land on different pooled backends.
  - Found while writing it: postgres.js runs a type-introspection query over the *extended* protocol on
    connect, which PgBouncer's admin console refuses (`extended query protocol not supported by admin
    console`). `fetch_types: false` is required, and it surfaced as a failure in an unrelated test with a
    message about a protocol nobody had written a query in.
  - `pnpm test:rls:local` is not separately runnable: it reads `RLS_TEST_*_URL` from
    `scripts/db/prepare-rls-fixture.mjs`, which `pnpm ci:local` prepares. Its evidence therefore comes
    from the gate — and that fixture is one of the two places this branch taught to copy the base roles'
    timeouts onto their member roles.
  - Result: 8/8 — five roles authenticating through 6432 with their exact timeouts *enforced* (57014 at
    5s, 15s and 30s through the pooler), no session-state leak across checkouts, sign-in plus a
    tenant-scoped 200 plus a cross-tenant read that is not 200, and `SHOW CONFIG` reporting transaction
    mode with 12/4/80/500.

## Phase 5 — Calibration and smoke gate

- [ ] **Run the pooled 10-minute calibration**
  - Files: `docs/operations/load-calibration-<date>.md`
  - Do: Repeat the baseline workload and host with only the runtime URLs changed to PgBouncer.
    Compare offered/achieved RPS, latency, status codes, PgBouncer waits, PostgreSQL backends, and
    host saturation. Update the spec budget if calibration lowers or otherwise changes a default;
    never exceed 80 pooled backends or 120 PostgreSQL connections.
  - Verify: the report links an immutable raw artifact, identifies `pool_mode=transaction`, includes
    every threshold and direct-baseline delta, and records pass/fail without hiding failed routes.
  - Operator: starting the 1,000-user calibration on the isolated host requires the same explicit
    confirmation as the baseline.

- [~] **Add a dedicated CI load smoke**
  - Files: `.github/workflows/load-smoke.yml`, `package.json`, `scripts/load/smoke.ts`
  - Do: Provision PostgreSQL 18, Redis, PgBouncer, a production app build, disposable fixtures, and
    25 users for 30 seconds. Run on workflow dispatch and on pull requests that change DB/pool/load
    files. Upload artifacts with a seven-day retention on success and failure.
  - Verify: `pnpm run test:load:smoke` passes locally; a workflow-dispatch run is green and its
    artifact contains no cookie, password, or credential-bearing URL; `pnpm ci:local` remains green.
  - Done: PostgreSQL 18 on the same pgvector pin as Quality, Redis, a production build, disposable
    fixtures, 25 users for 30 seconds, artifacts on success and failure with seven-day retention, and
    triggers on dispatch plus pull requests touching the harness. The smoke gates on correctness only
    — requests happened, no 5xx, the observability samples have data behind them, neither artifact
    carries a credential — and prints the thresholds without gating, because a shared two-core runner's
    percentiles describe the runner.
  - Size changed from 25 to 15, on the application's terms: `better-auth.ts` caps `/sign-in/email` at
    20 per minute per IP, so a 25-user run aborts on the 21st sign-in with a `429`. Verified locally,
    and correct behaviour. The smoke refuses that size up front with the reason rather than seeding a
    database first, and raising the cap to make a check pass would take a brute-force guard out of
    production to buy a larger number in CI.
  - **The PgBouncer leg landed 2026-08-11.** The job now builds the image, gives the five
    `builderhunt_*` roles freshly generated passwords on its ephemeral cluster (masked, one variable each,
    the same value reaching both the pooler's `userlist.txt` and the app's URLs), starts the pooler on the
    host network, and runs the smoke a second time with `LOAD_SMOKE_POOLED=true`. The pooled leg is the
    more faithful of the two: PgBouncer authenticates against those five roles, so unlike the direct leg —
    which connects as the job's superuser — RLS is actually in the path.
  - Found while wiring it: `pgbouncer.ini` hardcoded `host=db`, the compose service name, directly under a
    comment saying the upstream comes from the environment "because a host in a committed file is one edit
    away from being the wrong host". The comment described something the file did not do, and it made the
    image unusable anywhere `db` is not the hostname — CI reaches PostgreSQL on `127.0.0.1`, and Coolify's
    private network uses its own service name. The entrypoint now writes a `%include`d
    `/run/pgbouncer/databases.ini` from `PGBOUNCER_UPSTREAM_HOST`/`_PORT`, defaulting to `db:5432` so the
    compose profile is unchanged. Verified: the compose path still passes 13/13 preflight.
    Left open rather than claimed.
  - Also outstanding: the workflow-dispatch run itself, which needs the branch pushed.
  - Result locally: 15 users over 30 seconds, 199 requests, verdict `pass`, exit 0.

## Phase 6 — Certification and production rollout

  - **Reopened 2026-08-12: the job had never once executed, and it fails three ways.** Its Verify line asks for a
    green workflow-dispatch run; it only ever fired on `pull_request` and on pushes to master/dev, and the branch it
    was written on had neither until PR #31. What "Done" recorded was the file, not a run.
    - **`pnpm/action-setup@v4` with no `version`.** No `packageManager` in `package.json` for the action to read, so
      it died on the third step with "No pnpm version is specified" — every invocation, from the day it was written.
      Fixed: `@v6` with `version: 10`, matching the six other setups in this repository.
    - **GitGuardian failed on `POSTGRES_PASSWORD: postgres`.** Not wrong about the shape, even though the database
      lives for one job on a network only that job can reach. Fixed by removing the constant — `github.run_id` is
      unique per run — rather than by an ignore file that would have weakened the detector for every future file.
      That change had a trap: the pooled leg authenticates the five roles through `PGPASSWORD=postgres psql`, which
      the new password would have broken on the next run. Four places agree now.
    - **Still open: the preview server refuses to boot.** `❌ the preview server never answered /api/health`, and
      the cause is in the log beneath it: `ZodError: DATABASE_URL — "Production DATABASE_URL must use the non-owner
      application role"`. The workflow hands it `postgres`, the owner. A production build refuses that by design,
      and this repository has the scar the rule exists for — a superuser connection ignores GRANTs and RLS, which
      is what hid three defects.
  - **What the fix needs, so the next attempt does not start from the symptom.** The smoke creates and migrates its
    own disposable `builderhunt_load_test_smoke`, so the preview server's URL has to name *that* database *and*
    `builderhunt_app`. The app-role password is minted by the "Give the five roles passwords" step, which currently
    runs *after* the direct leg — so the ordering has to change too, and `DATABASE_URL` has to be exported through
    `$GITHUB_ENV` rather than set as static job-level env, because the password does not exist until that step runs.
    `DATABASE_MIGRATION_URL` stays the owner, which is correct and is what the app's own contract expects.
  - **Deliberately not attempted during the phase-3 release.** It is a non-required check on a workflow that has
    never worked, and the rest of this plan is blocked on provisioning an isolated host anyway. Half-fixing the
    ordering while a merge was in flight is how a release picks up an unrelated failure.
- [~] **Document the Coolify pooler rollout and rollback**
  - Files: `docs/operations/deploy-runbook.md`, `docs/operations/database-roles.md`,
    `docs/operations/load-testing.md`, `.env.production.example`
  - Do: Document the separate private-network PgBouncer service, five role-secret inputs, direct
    migration URL, healthcheck, preflight, low-rate smoke, metrics, stop conditions, and direct-URL
    rollback. State that generated auth files live only in tmpfs and that production load requires
    explicit approval.
  - Verify: a redacted dry run of the documented preflight passes on the isolated environment;
    `pnpm deploy:preflight`, `pnpm type-check`, and `pnpm ci:local` are green.
  - Written: `docs/operations/load-testing.md` (new — the harness, how to read a report without being
    misled, the three safety refusals, the sign-in ceiling, the connection budget, the local pooled
    topology, the Coolify rollout order, metrics with stop conditions, rollback, and what the harness
    does *not* cover); a pooling section in `deploy-runbook.md` at the rollback boundary where an
    operator is already looking; two sections in `database-roles.md` — role settings are not inherited
    through membership, and the transaction-local GUC the tenant boundary rests on under a pooler; and
    the six pooler secrets plus five pool caps in `.env.production.example`.
  - **Not done: the redacted dry run on the isolated environment.** There is no isolated environment
    provisioned — standing it up is one of the cost-bearing steps excluded from this branch by
    agreement. The documented preflight *was* run for real against the local pooled topology (13/13),
    which is the same script and the same assertions against a different host.
  - Result: `pnpm deploy:preflight` passed, `git diff --check` clean, `check-env-fidelity` 0 gaps.

- [ ] **Run the isolated two-hour certification**
  - Files: `docs/operations/load-certification-<date>.md`
  - Do: On the approved 4-vCPU/8-GB ARM64 environment, run two-minute ramp plus two hours at 1,000
    authenticated users through PgBouncer. Preserve raw artifacts, note any aborted interval, and
    evaluate every success criterion exactly as defined in `spec.md`.
  - Verify: the report links immutable raw artifacts, records 120 complete steady-state minutes,
    includes every threshold and host/pool/database peak, and marks the overall result `pass`. Any
    missed threshold leaves this task open.
  - Operator: provisioning the host and starting sustained traffic are cost-bearing/outward actions;
    obtain explicit confirmation immediately before the run.

- [ ] **Roll out PgBouncer to production after certification**
  - Files: `docs/operations/load-certification-<date>.md`,
    `docs/operations/deploy-runbook.md`
  - Do: After a fresh backup and explicit approval, deploy the pooler dark on Coolify's private
    network, verify health/admin metrics, schedule the PostgreSQL resource restart needed to set
    `max_connections=120`, then repoint only the five runtime role URLs and redeploy the certified
    app image. Keep the migration URL direct. Run sign-in, dashboard, negative RLS, worker,
    platform, and capability smokes; rollback immediately on any failure or PgBouncer wait breach.
  - Verify: Coolify shows a healthy PgBouncer service; PostgreSQL reports `max_connections=120`;
    all five runtime roles reach the database through PgBouncer; the migration role reaches
    PostgreSQL directly; the documented low-rate smokes and `pnpm deploy:preflight` pass; attach
    redacted timestamps and deployment identifiers to the certification report.
  - Operator: Coolify changes and a PostgreSQL restart affect the live service; obtain explicit
    confirmation immediately before execution.

- [ ] **Close the plan with runtime evidence**
  - Files: `plans/phase-1/55-load-1000-concurrent-users/spec.md`,
    `plans/phase-1/55-load-1000-concurrent-users/plan.md`,
    `plans/phase-1/55-load-1000-concurrent-users/tasks.md`
  - Do: Only after the certification passes, check every task, set all three statuses to
    `implemented`, add the certification date/artifact link, and record the shipped connection
    budget. Do not close from the calibration or CI smoke.
  - Verify: `pnpm plans:check-order`, `pnpm plans:check-tasks`, `pnpm ci:local`, and
    `git diff --check` pass; no unchecked task remains and the certification report says `pass`.
  - **Deliberately still open.** This task's own Do line forbids closing from the calibration or the CI
    smoke, and the certification is one of the four cost-bearing runs excluded from this branch by
    agreement (the 10-minute direct baseline, the pooled calibration, the two-hour soak, and the
    production rollout). Everything the certification needs is built and exercised at smoke scale; what
    remains is an isolated host, a window and an approval, not code.
