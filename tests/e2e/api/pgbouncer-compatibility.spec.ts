import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { e2eEnv } from '../harness/env'
import { LOOPBACK_FIXTURE_PASSWORD, seedLoadFixtures, type LoadFixtureManifest } from '../../../scripts/load/seed'

/**
 * What changes when a transaction pooler is in the path (plan 55 phase 4).
 *
 * ## Why this needs its own database and its own server
 *
 * The rest of the suite connects as per-database *member* roles that only the harness knows about, with a
 * fixed test password. PgBouncer authenticates against a `userlist.txt` generated from the five base roles'
 * passwords, so those member roles cannot authenticate through it at all — the pooler would refuse them, and
 * the failure would look like a pooling incompatibility rather than a harness detail. This spec therefore
 * creates one disposable database, grants the five base roles CONNECT on it, and drives everything through
 * them.
 *
 * ## What pooling can actually break, which is what this asserts
 *
 * Transaction pooling hands a client a *different* server connection per transaction. Three consequences
 * matter and none of them are visible in a direct run:
 *
 * - **Session state does not belong to the client.** A `SET` outside a transaction lands on whichever backend
 *   happened to serve it and is then handed to somebody else. `withTenantContext` sets its GUC with
 *   `set_config(..., true)` — transaction-local — and that distinction is the entire tenant boundary under a
 *   pooler. If it were session-scoped, tenant A's context would leak to tenant B's request.
 * - **Role settings apply per connection.** The 5/10-second timeouts come from `ALTER ROLE ... SET`, which
 *   PostgreSQL applies at connection time — so they have to survive the pooler handing out a connection that
 *   was opened earlier, for a different client.
 * - **Prepared statements do not survive a checkout.** `prepare: false` everywhere is why the app works here
 *   at all, and a regression would surface as `prepared statement "s1" does not exist` under load and never
 *   in development.
 *
 * ## Why it skips rather than fails without the pooler
 *
 * PgBouncer lives behind a compose profile, so a developer running the suite normally does not have it. A
 * failing spec there would train people to ignore a red test; a skip with a reason names what is not being
 * checked. `pnpm ci:local` and CI do not run the load profile either, which is stated in the plan.
 */

const DATABASE_NAME = 'builderhunt_load_test_pgbouncer'
const POOLER_PORT = 6432

/** The budget from `drizzle/0168_role_timeouts.sql`, restated so a drift is visible. */
const ROLES = [
  { role: 'builderhunt_app', passwordEnv: 'BUILDERHUNT_APP_PASSWORD', statement: 5, idle: 10 },
  { role: 'builderhunt_auth', passwordEnv: 'BUILDERHUNT_AUTH_PASSWORD', statement: 5, idle: 10 },
  { role: 'builderhunt_worker', passwordEnv: 'BUILDERHUNT_WORKER_PASSWORD', statement: 30, idle: 30 },
  { role: 'builderhunt_platform', passwordEnv: 'BUILDERHUNT_PLATFORM_PASSWORD', statement: 15, idle: 10 },
  { role: 'builderhunt_capability', passwordEnv: 'BUILDERHUNT_CAPABILITY_PASSWORD', statement: 5, idle: 10 },
] as const

let manifest: LoadFixtureManifest
let server: ChildProcess | undefined
let appBaseUrl = ''
let skipReason = ''

function pooledUrl(role: string, password: string, database = DATABASE_NAME): string {
  return `postgresql://${role}:${encodeURIComponent(password)}@127.0.0.1:${POOLER_PORT}/${database}`
}

/**
 * A client for PgBouncer's admin console, which is not PostgreSQL.
 *
 * `fetch_types: false` is not an optimisation. On connect, postgres.js runs a type-introspection query over
 * the *extended* query protocol, and the admin console answers `extended query protocol not supported by
 * admin console` — which surfaces as a failure in whichever test happens to touch it first, with a message
 * about a protocol nobody wrote a query in. `compose-preflight.mjs` already carries this option and the
 * comment explaining it; this spec had to learn it again.
 */
function adminConsole(): Sql {
  return postgres(pooledUrl('pgbouncer', process.env.PGBOUNCER_ADMIN_PASSWORD ?? '', 'pgbouncer'), {
    max: 1,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 2,
    fetch_types: false,
  })
}

function passwordFor(role: (typeof ROLES)[number]): string | undefined {
  const value = process.env[role.passwordEnv]
  return value && value.length > 0 ? value : undefined
}

/** Seconds from PostgreSQL's normalised interval string — `5000ms` and `5s` are the same budget. */
function toSeconds(value: string): number | null {
  const match = /^(\d+)(ms|s|min)?$/.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  return match[2] === 'ms' ? amount / 1000 : match[2] === 'min' ? amount * 60 : amount
}

async function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? done(port) : reject(new Error('no free port'))))
    })
  })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(600_000)

  const missing = ROLES.filter((entry) => !passwordFor(entry)).map((entry) => entry.passwordEnv)
  if (missing.length > 0) {
    skipReason = `no pooler credentials in the environment (${missing.join(', ')})`
    return
  }

  const probe = adminConsole()
  const reachable = await probe
    .unsafe('SHOW CONFIG')
    .then(() => true)
    .catch(() => false)
  await probe.end({ timeout: 2 }).catch(() => undefined)
  if (!reachable) {
    skipReason = `no PgBouncer on 127.0.0.1:${POOLER_PORT} — start it with docker compose --profile standalone --profile load up -d pgbouncer`
    return
  }

  const adminUrl = e2eEnv().DATABASE_MIGRATION_URL
  const direct = new URL(adminUrl)
  direct.pathname = `/${DATABASE_NAME}`

  const root = postgres(adminUrl, { max: 1, prepare: false })
  try {
    await root.unsafe(`drop database if exists ${DATABASE_NAME} with (force)`)
    await root.unsafe(`create database ${DATABASE_NAME}`)
    for (const entry of ROLES) {
      await root.unsafe(`grant connect on database ${DATABASE_NAME} to ${entry.role}`)
    }
  } finally {
    await root.end({ timeout: 5 }).catch(() => undefined)
  }

  /**
   * DDL goes direct, on 5432, never through the pooler.
   *
   * A migration runs many statements in one transaction and takes advisory locks; under transaction pooling
   * it would be handed a different backend between statements and the locks would be released underneath it.
   * The migrator also gets a connection of its own that is never reused — afterwards, every `${Date}` on that
   * client throws.
   */
  const migrator = postgres(direct.toString(), { max: 1, prepare: false })
  try {
    await migrate(drizzle(migrator), { migrationsFolder: 'drizzle' })
  } finally {
    await migrator.end({ timeout: 5 }).catch(() => undefined)
  }

  // Two tenants, because the interesting assertion is that one cannot read the other through the pooler.
  manifest = await seedLoadFixtures({
    databaseUrl: direct.toString(),
    runIdSuffix: 'pgbouncer',
    counts: { users: 2, builderIdentities: 10, sprintResultsPerOrganization: 3 },
    log: () => undefined,
  })

  const port = await freePort()
  appBaseUrl = `http://127.0.0.1:${port}`
  const appPassword = passwordFor(ROLES[0]) ?? ''
  server = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Every runtime URL through the pooler; only the migration URL stays direct.
      DATABASE_URL: pooledUrl('builderhunt_app', appPassword),
      DATABASE_AUTH_URL: pooledUrl('builderhunt_auth', passwordFor(ROLES[1]) ?? ''),
      DATABASE_WORKER_URL: pooledUrl('builderhunt_worker', passwordFor(ROLES[2]) ?? ''),
      DATABASE_PLATFORM_URL: pooledUrl('builderhunt_platform', passwordFor(ROLES[3]) ?? ''),
      DATABASE_CAPABILITY_URL: pooledUrl('builderhunt_capability', passwordFor(ROLES[4]) ?? ''),
      DATABASE_MIGRATION_URL: direct.toString(),
      APP_URL: appBaseUrl,
      VITE_APP_URL: appBaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout?.on('data', (chunk) => (output += String(chunk)))
  server.stderr?.on('data', (chunk) => (output += String(chunk)))

  const deadline = Date.now() + 90_000
  let healthy = false
  while (Date.now() < deadline && !healthy) {
    if (server.exitCode !== null) throw new Error(`the pooled preview server exited (${server.exitCode}):\n${output}`)
    healthy = await fetch(`${appBaseUrl}/api/health`).then((r) => r.ok).catch(() => false)
    if (!healthy) await new Promise((done) => setTimeout(done, 500))
  }
  if (!healthy) throw new Error(`the pooled preview server never answered /api/health:\n${output}`)
})

test.afterAll(async () => {
  server?.kill('SIGTERM')
  const adminUrl = e2eEnv().DATABASE_MIGRATION_URL
  const root = postgres(adminUrl, { max: 1, prepare: false })
  try {
    await new Promise((done) => setTimeout(done, 1_000))
    await root.unsafe(`drop database if exists ${DATABASE_NAME} with (force)`)
  } catch {
    // A leftover disposable database is noise, not a failure to report from teardown.
  } finally {
    await root.end({ timeout: 5 }).catch(() => undefined)
  }
})

for (const entry of ROLES) {
  test(`${entry.role} authenticates through the pooler and keeps its timeouts`, async () => {
    test.skip(skipReason !== '', skipReason)
    test.setTimeout((entry.statement + 60) * 1_000)

    let sql: Sql | undefined
    try {
      sql = postgres(pooledUrl(entry.role, passwordFor(entry) ?? ''), { max: 1, prepare: false })

      const [identity] = await sql.unsafe('select current_user')
      expect(String(identity.current_user)).toBe(entry.role)

      /**
       * The timeouts, read through the pooler.
       *
       * `ALTER ROLE ... SET` is applied at connection time, and under transaction pooling the connection was
       * opened earlier and possibly for another client. If PgBouncer handed out a backend whose session had
       * been reset to defaults, this is where a 5-second bound silently becomes unlimited.
       */
      const [statement] = await sql.unsafe('show statement_timeout')
      const [idle] = await sql.unsafe('show idle_in_transaction_session_timeout')
      expect(toSeconds(String(statement.statement_timeout))).toBe(entry.statement)
      expect(toSeconds(String(idle.idle_in_transaction_session_timeout))).toBe(entry.idle)

      // And enforced, not merely reported — matched on SQLSTATE because the message is localised.
      await expect(sql.unsafe(`select pg_sleep(${entry.statement + 1})`)).rejects.toMatchObject({ code: '57014' })
    } finally {
      await sql?.end({ timeout: 5 }).catch(() => undefined)
    }
  })
}

test('session state does not survive a checkout', async () => {
  test.skip(skipReason !== '', skipReason)

  /**
   * The property the tenant boundary rests on.
   *
   * `withTenantContext` sets its GUC transaction-locally (`set_config(..., true)`). If it ever became
   * session-scoped, the value would stay on the backend after the transaction ended, and the next client to
   * be handed that backend would inherit another tenant's context — a cross-tenant read that no application
   * code is wrong about.
   *
   * Asserted with `max: 2` so the two queries can land on different pooled backends, which is exactly the
   * condition being tested.
   */
  const sql = postgres(pooledUrl('builderhunt_app', passwordFor(ROLES[0]) ?? ''), { max: 2, prepare: false })
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('app.current_organization_id', 'org-from-a-transaction', true)`)
      const [inside] = await tx.unsafe(`select current_setting('app.current_organization_id', true) as value`)
      expect(inside.value).toBe('org-from-a-transaction')
    })

    // After the transaction, on whichever backend the pooler gives next.
    const [after] = await sql.unsafe(`select current_setting('app.current_organization_id', true) as value`)
    expect(after.value === null || after.value === '').toBe(true)
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined)
  }
})

test('the application signs in and reads its own tenant through the pooler', async () => {
  test.skip(skipReason !== '', skipReason)

  const [tenant] = manifest.users
  const signIn = await fetch(`${appBaseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: appBaseUrl },
    body: JSON.stringify({ email: tenant.email, password: LOOPBACK_FIXTURE_PASSWORD }),
    redirect: 'manual',
  })
  expect(signIn.status, 'sign-in through the pooler').toBe(200)
  const cookie = signIn.headers
    .getSetCookie()
    .map((entry) => entry.split(';', 1)[0]?.trim())
    .filter((pair): pair is string => Boolean(pair?.includes('=')))
    .join('; ')
  expect(cookie).not.toBe('')

  // A real tenant-scoped read: this is the path that opens a transaction, sets the GUC and depends on RLS.
  const dashboard = await fetch(`${appBaseUrl}/api/dashboard/overview`, {
    headers: { cookie, accept: 'application/json' },
  })
  expect(dashboard.status).toBe(200)

  /**
   * The negative case, through the pooler.
   *
   * Tenant A asks for tenant B's sprint results by id. It must not be a 200 — and the reason it is not has
   * to survive transaction pooling, because the boundary is a transaction-local GUC plus an RLS policy, both
   * of which are properties of a connection the pooler owns rather than the client.
   */
  const [, other] = manifest.users
  const crossTenant = await fetch(`${appBaseUrl}/api/sprints/${encodeURIComponent(other.sprintId)}/results`, {
    headers: { cookie, accept: 'application/json' },
  })
  expect(crossTenant.status, 'another tenant\'s sprint must not be readable').not.toBe(200)

  // Its own sprint, for contrast: without this the assertion above would pass against a route that is simply
  // broken for everyone.
  const ownSprint = await fetch(`${appBaseUrl}/api/sprints/${encodeURIComponent(tenant.sprintId)}/results`, {
    headers: { cookie, accept: 'application/json' },
  })
  expect(ownSprint.status, 'the tenant\'s own sprint must be readable').toBe(200)
})

test('PgBouncer is in transaction mode with the budget the report asserts', async () => {
  test.skip(skipReason !== '', skipReason)

  /**
   * Read from the pooler rather than from the ini.
   *
   * What the certification report means depends on the configuration that was actually in force, and a file
   * in the repository is not evidence about a running container — the tmpfs that shadowed `pgbouncer.ini`
   * shipped a container that could not start while the committed ini was perfectly correct.
   */
  const sql = adminConsole()
  try {
    const rows = await sql.unsafe<Array<{ key: string; value: string }>>('SHOW CONFIG')
    const config = new Map(rows.map((row) => [String(row.key), String(row.value)]))
    expect(config.get('pool_mode')).toBe('transaction')
    expect(config.get('default_pool_size')).toBe('12')
    expect(config.get('reserve_pool_size')).toBe('4')
    expect(config.get('max_db_connections')).toBe('80')
    expect(config.get('max_client_conn')).toBe('500')
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined)
  }
})
