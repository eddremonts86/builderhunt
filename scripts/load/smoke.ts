/**
 * The whole load harness, end to end, small enough for CI (plan 55 phase 4).
 *
 * ## What this is protecting
 *
 * Every part of the harness has unit tests, and unit tests cannot catch the failures that actually happen
 * here: a preflight that passes against an unseeded database, a cookie header that is silently anonymous, a
 * report whose JSON carries the connection string it was built from. Each of those produces a *plausible*
 * artifact, which is the dangerous kind. So this creates a disposable database, migrates it, seeds it, starts
 * the real production build against it, drives a two-user run, and asserts on the files that come out —
 * including that they contain no credential substring.
 *
 * ## Why it runs the shipping build rather than the dev server
 *
 * A load harness that only works against `vite dev` proves nothing about the artifact that gets deployed, and
 * the two differ in the places that matter here: bundling, `NODE_ENV`, and compression. The E2E suite learned
 * this already — `tests/e2e/harness/server.ts` serves `dist` for the same reason.
 *
 * Usage:
 *   pnpm test:load:smoke
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { LOAD_EXIT_CODES, SMOKE_LOAD_CONFIG } from './config'
import { cleanupLoadFixtures } from './cleanup'
import { runLoadTest } from './runner'
import { manifestPath, seedLoadFixtures } from './seed'

const DATABASE_NAME = 'builderhunt_load_test_smoke'
/**
 * Two users and ten seconds by default — the size the task's Verify line names, and small enough that CI
 * pays seconds for it.
 *
 * Overridable because the same script is the only end-to-end path through the harness, so a longer local run
 * (the spec's thirty seconds, enough to collect several observability samples) should not need a second
 * script that could drift from this one.
 */
/**
 * `LOAD_SMOKE_POOLED=true` runs the same smoke through PgBouncer instead of straight at PostgreSQL.
 *
 * The pooled leg is not a nice-to-have variant: it is the only one that exercises what a transaction
 * pooler changes — a different server connection per transaction, session state that does not belong to
 * the client, and prepared statements that do not survive a checkout. And it is *more* faithful than the
 * direct leg here, because it necessarily connects as the five `builderhunt_*` roles rather than as the
 * CI superuser, so RLS is actually in the path.
 */
const POOLED = process.env.LOAD_SMOKE_POOLED === 'true'
const POOLER_PORT = Number(process.env.LOAD_SMOKE_POOLER_PORT ?? '6432')

const SMOKE_USERS = Number(process.env.LOAD_SMOKE_USERS ?? '2')
const SMOKE_SECONDS = Number(process.env.LOAD_SMOKE_SECONDS ?? '10')

/**
 * The most users one host can sign in inside a minute.
 *
 * `better-auth.ts` caps `/sign-in/email` at 20 per minute per IP, and every virtual user signs in from this
 * machine. A smoke asking for 25 therefore aborts on the 21st with a `429` — which is the application
 * behaving correctly, and is why this refuses up front instead of after seeding a database and building a
 * server. Raising the cap to make a test pass would remove a brute-force guard from production to buy a
 * larger number here.
 */
const SIGN_IN_LIMIT_PER_MINUTE = 20

function fail(message: string): never {
  console.error(`❌  ${message}`)
  process.exit(1)
}

async function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? done(port) : reject(new Error('could not find a free port'))))
    })
  })
}

/** Swaps the database name while keeping the role and password the environment already carries. */
function withDatabase(rawUrl: string, databaseName: string): string {
  const url = new URL(rawUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

/**
 * The substrings that must not appear in an artifact.
 *
 * Built from the live environment rather than from a fixed list, because the value that would leak is the one
 * this machine is configured with — a fixed list cannot know it.
 *
 * ## Why the password is looked for inside a URL and not on its own
 *
 * The first version scanned for the bare password, and failed the smoke on a report that had leaked nothing:
 * the local migration role's password is the word `postgres`, and the report contains the field name
 * `postgresConnections`. A check that cries wolf on a clean artifact gets switched off, and then it is not
 * protecting anything.
 *
 * `:<password>@` is the shape a credential actually leaks in, because the only way one reaches a report is
 * inside a connection string. It has no collisions with English, so a match is a leak and every match is
 * worth stopping the build for. The bare password is still scanned when it is long enough to be unambiguous
 * on its own — a dictionary word is not, a 29-character secret is.
 */
function forbiddenSubstrings(): string[] {
  const out = new Set<string>(['postgres://', 'postgresql://', 'password='])
  for (const key of ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_WORKER_URL', 'DATABASE_AUTH_URL']) {
    const raw = process.env[key]
    if (!raw) continue
    try {
      const parsed = new URL(raw)
      if (!parsed.password) continue
      const password = decodeURIComponent(parsed.password)
      out.add(`:${password}@`)
      // Long enough that it cannot be a word the report legitimately uses.
      if (password.length >= 16) out.add(password)
    } catch {
      // An unparseable URL contributes nothing; the shape checks above still apply.
    }
  }
  return [...out].filter((entry) => entry.length >= 4)
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_MIGRATION_URL
  const appUrl = process.env.DATABASE_URL
  if (!adminUrl) fail('DATABASE_MIGRATION_URL is not set')
  if (!appUrl) fail('DATABASE_URL is not set')
  if (!existsSync(join(process.cwd(), 'dist'))) {
    fail('no dist/ — the smoke serves the production build, so run `pnpm build` first')
  }
  if (SMOKE_USERS >= SIGN_IN_LIMIT_PER_MINUTE) {
    fail(
      `LOAD_SMOKE_USERS=${SMOKE_USERS} cannot sign in: better-auth.ts allows ${SIGN_IN_LIMIT_PER_MINUTE} ` +
        'sign-ins per minute per IP, and this run has one. Use a smaller size, or raise the limit on a ' +
        'disposable load host deliberately — not to make this pass.',
    )
  }

  const targetAdmin = withDatabase(adminUrl, DATABASE_NAME)
  const targetApp = withDatabase(appUrl, DATABASE_NAME)

  /**
   * The five runtime URLs, pooled or direct.
   *
   * Pooled means port 6432 *and* a `builderhunt_*` role, because PgBouncer authenticates against a
   * `userlist.txt` built from those five roles and would refuse anything else — the superuser included.
   * The passwords come from the same `BUILDERHUNT_*_PASSWORD` variables the pooler's own entrypoint reads,
   * so there is exactly one source for each and no chance of the two disagreeing.
   */
  const roleUrl = (role: string, passwordEnv: string): string => {
    const password = process.env[passwordEnv]
    if (!password) {
      fail(`${passwordEnv} is required for a pooled run — the pooler's userlist is built from the same value`)
    }
    return `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:${POOLER_PORT}/${DATABASE_NAME}`
  }
  const runtimeUrls = POOLED
    ? {
        DATABASE_URL: roleUrl('builderhunt_app', 'BUILDERHUNT_APP_PASSWORD'),
        DATABASE_AUTH_URL: roleUrl('builderhunt_auth', 'BUILDERHUNT_AUTH_PASSWORD'),
        DATABASE_WORKER_URL: roleUrl('builderhunt_worker', 'BUILDERHUNT_WORKER_PASSWORD'),
        DATABASE_PLATFORM_URL: roleUrl('builderhunt_platform', 'BUILDERHUNT_PLATFORM_PASSWORD'),
        DATABASE_CAPABILITY_URL: roleUrl('builderhunt_capability', 'BUILDERHUNT_CAPABILITY_PASSWORD'),
      }
    : {
        DATABASE_URL: targetApp,
        DATABASE_AUTH_URL: withDatabase(process.env.DATABASE_AUTH_URL ?? appUrl, DATABASE_NAME),
        DATABASE_WORKER_URL: withDatabase(process.env.DATABASE_WORKER_URL ?? appUrl, DATABASE_NAME),
        DATABASE_PLATFORM_URL: withDatabase(process.env.DATABASE_PLATFORM_URL ?? appUrl, DATABASE_NAME),
        DATABASE_CAPABILITY_URL: withDatabase(process.env.DATABASE_CAPABILITY_URL ?? appUrl, DATABASE_NAME),
      }

  /**
   * Says so out loud when the application is about to connect as a superuser.
   *
   * A superuser bypasses RLS entirely, so every tenant-scoped read is faster than it will ever be in
   * production and the run measures a database with its isolation switched off. Locally `.env` names
   * `builderhunt_app`, which is the honest path; CI has only the superuser the service container was created
   * with. That is an acceptable trade for a correctness smoke and an unacceptable one for a capacity number,
   * so the difference is printed rather than left for a reader to infer from a URL nobody prints.
   */
  const appRole = decodeURIComponent(new URL(POOLED ? runtimeUrls.DATABASE_URL : targetApp).username)
  if (!appRole.startsWith('builderhunt_')) {
    console.log(`⚠️   the application will connect as \`${appRole}\`, not a builderhunt_* role:`)
    console.log('     RLS is not in the path, so these latencies are a floor and not a measurement')
  }

  const root = postgres(adminUrl, { max: 1, prepare: false })
  try {
    await root.unsafe(`drop database if exists ${DATABASE_NAME}`)
    await root.unsafe(`create database ${DATABASE_NAME}`)
  } finally {
    await root.end({ timeout: 5 }).catch(() => undefined)
  }

  // Its own connection, never reused: after `migrate()` a postgres.js client rejects every Date binding.
  const migrator = postgres(targetAdmin, { max: 1, prepare: false })
  try {
    await migrate(drizzle(migrator), { migrationsFolder: 'drizzle' })
  } finally {
    await migrator.end({ timeout: 5 }).catch(() => undefined)
  }
  console.log(`migrated ${DATABASE_NAME}`)

  const manifest = await seedLoadFixtures({
    databaseUrl: targetAdmin,
    runIdSuffix: 'smoke',
    // The smoke profile's user count, not the full thousand: enough that the runner's manifest slice, the
    // sign-in loop and every route's fixtures are all exercised.
    counts: { users: SMOKE_LOAD_CONFIG.users, sprintResultsPerOrganization: 5 },
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(
    'pnpm',
    ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // The application connects as its own role against the disposable database — not as a superuser,
        // which would bypass RLS and make every tenant-scoped read faster than it will ever be in production.
        ...runtimeUrls,
        // Never pooled. A migration takes advisory locks across statements, and transaction pooling would
        // hand it a different backend between them and release them underneath it.
        DATABASE_MIGRATION_URL: targetAdmin,
        APP_URL: baseUrl,
        VITE_APP_URL: baseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let serverOutput = ''
  server.stdout?.on('data', (chunk) => (serverOutput += String(chunk)))
  server.stderr?.on('data', (chunk) => (serverOutput += String(chunk)))

  const shutdown = (): void => {
    if (!server.killed) server.kill('SIGTERM')
  }
  process.on('exit', shutdown)

  try {
    const deadline = Date.now() + 60_000
    let healthy = false
    while (Date.now() < deadline && !healthy) {
      if (server.exitCode !== null) fail(`the preview server exited (${server.exitCode}):\n${serverOutput}`)
      healthy = await fetch(`${baseUrl}/api/health`)
        .then((response) => response.ok)
        .catch(() => false)
      if (!healthy) await new Promise((done) => setTimeout(done, 500))
    }
    if (!healthy) fail(`the preview server never answered /api/health:\n${serverOutput}`)
    console.log(`preview server ready on ${baseUrl}`)

    const result = await runLoadTest({
      baseUrl,
      manifestPath: manifestPath(manifest.runId),
      config: {
        ...SMOKE_LOAD_CONFIG,
        users: SMOKE_USERS,
        stages: { rampSeconds: 2, steadySeconds: SMOKE_SECONDS },
      },
      poolMode: POOLED ? 'transaction' : 'direct',
      // Monitoring on, so the smoke also proves the sampler runs and that its numbers reach the report.
      // The monitor's database connection stays direct either way — it is measuring PostgreSQL, and
      // routing it through the pooler would make it one more client competing for the pool it observes.
      monitorDatabaseUrl: targetAdmin,
      poolerAdminUrl: POOLED
        ? `postgresql://pgbouncer:${encodeURIComponent(process.env.PGBOUNCER_ADMIN_PASSWORD ?? '')}@127.0.0.1:${POOLER_PORT}/pgbouncer`
        : undefined,
    })

    const json = await readFile(result.jsonPath, 'utf8')
    const markdown = await readFile(result.markdownPath, 'utf8')
    JSON.parse(json)

    for (const forbidden of forbiddenSubstrings()) {
      // The needle itself is never printed — naming which secret leaked in a CI log would be the leak.
      if (json.includes(forbidden)) fail('the JSON report contains a credential substring')
      if (markdown.includes(forbidden)) fail('the Markdown report contains a credential substring')
    }

    const report = JSON.parse(json) as {
      verdict: string
      exitCode: number
      totals: { requests: number; serverErrors: number; unexpected: number; timeouts: number }
      peaks: { postgresConnections: number }
      checks: Array<{ metric: string; observed: string; pass: boolean }>
    }

    /**
     * What a two-user, ten-second run can honestly assert.
     *
     * Correctness, not capacity. Nine requests cannot say anything about a percentile — the first request
     * against a cold preview server took 1,708 ms and *was* the p95 — so gating on latency here would make
     * the smoke fail for a reason that has nothing to do with the change under test, every time. The
     * thresholds are still evaluated and still printed; they are simply not this check's business.
     *
     * What it does gate on is everything a size-independent defect would show up in: that requests happened
     * at all, that none of them 5xx'd or came back unexpected, that the observability samples have data
     * behind them, and that neither artifact carries a credential.
     */
    // The abort reason first: it is the informative failure, and checking the request count before it
    // reported "no requests at all" for a run whose actual problem was the sign-in rate limiter.
    if (report.verdict === 'aborted') {
      fail(`the run aborted: ${report.abortedReason ?? `see ${result.markdownPath}`}`)
    }
    if (report.totals.requests === 0) fail('the run recorded no requests at all')
    if (report.exitCode !== result.exitCode) fail('the report exit code and the runner disagree')
    if (report.totals.serverErrors > 0) fail(`${report.totals.serverErrors} requests returned 5xx`)
    if (report.totals.unexpected > 0) fail(`${report.totals.unexpected} requests returned an unexpected status`)
    if (report.totals.timeouts > 0) fail(`${report.totals.timeouts} requests timed out`)
    // Zero would mean the monitor never saw the application's own pool — which is how a passing
    // connection-ceiling check ends up with no observations behind it.
    if (report.peaks.postgresConnections === 0) fail('the monitor observed no PostgreSQL connections')
    if (![LOAD_EXIT_CODES.pass, LOAD_EXIT_CODES.thresholdBreach].includes(report.exitCode as 0 | 2)) {
      fail(`unexpected exit code ${report.exitCode}`)
    }

    const breached = report.checks.filter((entry) => !entry.pass).map((entry) => entry.metric)
    if (breached.length > 0) {
      console.log(`    thresholds not gated at smoke size, and breached: ${breached.join(', ')}`)
    }
    console.log(`✅  ${report.totals.requests} requests, verdict ${report.verdict}, exit ${report.exitCode}`)
    console.log(`    ${result.markdownPath}`)
  } finally {
    shutdown()
    await cleanupLoadFixtures({ databaseUrl: targetAdmin, runId: manifest.runId }).catch(() => undefined)
    const drop = postgres(adminUrl, { max: 1, prepare: false })
    try {
      // The preview server's pool has to be gone first, or `drop database` blocks on its connections.
      await new Promise((done) => setTimeout(done, 1_000))
      await drop.unsafe(`drop database if exists ${DATABASE_NAME} with (force)`)
    } finally {
      await drop.end({ timeout: 5 }).catch(() => undefined)
    }
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : 'unknown error')
})
