/**
 * The thousand-user fixture a load run reads from (plan 55 phase 0).
 *
 * ## What "read-heavy" demands of a fixture
 *
 * The five routes in `LOAD_ROUTES` are all reads, so every one of them returns an empty result — fast, and
 * from an index-only scan — against an empty database. A run against empty tables therefore certifies
 * nothing at all while producing the best numbers the system will ever show. Each route needs *bounded but
 * non-empty* rows behind it, which is what the counts below are for.
 *
 * ## Why the run id lives in the primary keys
 *
 * Every row this script writes carries the run id inside its `id`, and `cleanup.ts` deletes by that prefix.
 * The alternative — a `load_run_id` column — would mean a migration, and a production table would carry a
 * column that exists only for a script that must never touch production. The prefix costs nothing, is
 * visible in any `select`, and makes two concurrent operators on one disposable host safe from each other.
 *
 * ## Why the password is hashed once
 *
 * Better Auth's scrypt is deliberately slow, and a thousand of them is minutes of a laptop's CPU spent
 * proving the same thing a thousand times. Every fixture user shares one password, so it is hashed once and
 * the hash is reused. That means every fixture account shares a salt, which for credentials that exist only
 * inside a loopback disposable database is the correct trade — and is the same reasoning behind
 * `E2E_ROLE_PASSWORD` being a constant in this repository.
 *
 * Usage:
 *   LOAD_DATABASE_URL=postgresql://…/builderhunt_load_test_1 pnpm load:seed
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { hashPassword } from 'better-auth/crypto'
import postgres, { type Sql } from 'postgres'
import { personalOrganizationId, personalOrganizationSlug } from '../../src/shared/lib/migration/backfill'
import {
  assertDisposableLoadTarget,
  assertFixturePassword,
  loadRunId,
  remoteAllowedFromEnv,
  type LoadTarget,
} from './safety'

/**
 * The one password every fixture user shares.
 *
 * Public on purpose, like `E2E_ROLE_PASSWORD`: these accounts cannot exist anywhere the three refusals in
 * `safety.ts` allow the script to run, so a secret here would protect nothing and would have to be threaded
 * to the runner through a file that then holds a credential.
 */
export const LOOPBACK_FIXTURE_PASSWORD = 'builderhunt_load_test_password'

/**
 * The password every fixture user shares, for this target.
 *
 * Loopback keeps the constant above: those accounts are unreachable, and a secret there would protect
 * nothing while having to be threaded to the runner through a file that then holds a credential. Anything
 * else — a remote disposable host, or production — must supply `LOAD_FIXTURE_PASSWORD`, because a thousand
 * accounts carrying a git-published password on a reachable host is an access problem rather than a data
 * one. `assertFixturePassword` is where that is enforced.
 */
export function fixturePasswordFor(target: LoadTarget): string {
  return assertFixturePassword(target, LOOPBACK_FIXTURE_PASSWORD)
}

/**
 * How many rows sit behind each route, and why each number is what it is.
 *
 * Bounded, because the fixture has to fit in a laptop's disposable database and be re-seedable in under a
 * minute — and because the plan's read paths are all paginated, so a hundred thousand rows would exercise
 * exactly the same query plan as five thousand while making every iteration slower.
 *
 * Non-trivial, because a single row per organization lets an index-only scan answer everything and hides the
 * sort and the join the real query does.
 */
export const FIXTURE_COUNTS = {
  users: 1_000,
  /** Shared across organizations — `builder_identities` is the global discovery table, not tenant data. */
  builderIdentities: 200,
  /** Enough that `/api/builders/recent` has to order and page rather than return everything it finds. */
  builderRowsPerOrganization: 5,
  alertsPerOrganization: 1,
  /** Two of the three left unread, so `unread-count` returns a non-zero count from a partial index. */
  triggersPerOrganization: 3,
  unreadTriggersPerOrganization: 2,
  savedQueriesPerOrganization: 2,
  /** One sprint per organization gives `/api/sprints/:sprintId/results` a per-user path to hit. */
  sprintResultsPerOrganization: 20,
} as const

/** Rows per statement. Postgres caps parameters at 65535, and each row here costs at most nine. */
const INSERT_BATCH = 500

export interface LoadFixtureUser {
  email: string
  organizationId: string
  sprintId: string
  /**
   * Carried since 2026-08-14 for `mintSessions`, which needs `auth_sessions.user_id`.
   *
   * The email happens to be `${userId}@load.local`, so this is derivable today — and that is exactly
   * why it is written down instead. A consumer that parsed the id back out of the address would keep
   * working until somebody changed the fixture's email format for an unrelated reason, and then fail
   * as a wrong `user_id` rather than as a missing one.
   */
  userId: string
}

export interface LoadFixtureManifest {
  runId: string
  seededAt: string
  /**
   * The password is deliberately absent.
   *
   * The runner imports `LOAD_FIXTURE_PASSWORD` from this module instead. A manifest is a file somebody
   * attaches to a ticket when a run misbehaves, and a file that contains the word `password` is one nobody
   * can attach without thinking about it first.
   */
  users: LoadFixtureUser[]
  counts: Record<string, number>
}

export function manifestPath(runId: string): string {
  return resolve(process.cwd(), 'tests/artifacts/load', `${runId}-fixtures.json`)
}

/** `ld_<runId>_<kind><ordinal>` — the prefix `cleanup.ts` scopes every delete on. */
function fixtureId(runId: string, kind: string, ordinal: number | string): string {
  return `ld_${runId}_${kind}${ordinal}`
}

async function insertBatched(sql: Sql, table: string, rows: Record<string, unknown>[]): Promise<number> {
  let written = 0
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
    const batch = rows.slice(offset, offset + INSERT_BATCH)
    // `sql(batch)` expands to a multi-row VALUES list with the keys of the first row as columns, so every
    // row in a batch must carry the same keys. Built by one `map` each below, so they do.
    await sql`insert into ${sql(table)} ${sql(batch)}`
    written += batch.length
  }
  return written
}

export interface SeedOptions {
  databaseUrl: string | undefined
  runIdSuffix?: string
  now?: Date
  /**
   * Overrides for a fast integration check that still exercises every table.
   *
   * `Record<…, number>` and not `Partial<typeof FIXTURE_COUNTS>`: the constant is `as const`, so the
   * second form types every field as the literal it happens to default to — `users: 1000` accepts only
   * `1000`, which makes an override the one thing it cannot express.
   */
  counts?: Partial<Record<keyof typeof FIXTURE_COUNTS, number>>
  log?: (message: string) => void
}

export async function seedLoadFixtures(options: SeedOptions): Promise<LoadFixtureManifest> {
  // The URL comes from the guard or not at all — there is no parameter that bypasses the three refusals.
  const target = assertDisposableLoadTarget(options.databaseUrl, {
    allowRemote: remoteAllowedFromEnv(),
  })
  const counts = { ...FIXTURE_COUNTS, ...options.counts }
  const now = options.now ?? new Date()
  const runId = loadRunId(now, options.runIdSuffix ?? 'seed')
  const log = options.log ?? ((message: string) => console.log(message))

  const sql = postgres(target.url, { max: 4, prepare: false, idle_timeout: 20 })
  const written: Record<string, number> = {}
  try {
    log(`seeding ${counts.users} users into ${target.databaseName} as run ${runId}`)

    // One scrypt call for the whole fixture — see the module comment.
    const passwordHash = await hashPassword(fixturePasswordFor(target))

    const userIds = Array.from({ length: counts.users }, (_, i) =>
      fixtureId(runId, 'u', String(i).padStart(4, '0')),
    )
    written.auth_users = await insertBatched(
      sql,
      'auth_users',
      userIds.map((id, i) => ({
        id,
        name: `Load Fixture ${i}`,
        email: `${id}@load.local`,
        email_verified: true,
        created_at: now,
        updated_at: now,
      })),
    )
    written.auth_accounts = await insertBatched(
      sql,
      'auth_accounts',
      userIds.map((id) => ({
        id: fixtureId(runId, 'a', id.slice(-4)),
        user_id: id,
        account_id: `${id}@load.local`,
        provider_id: 'credential',
        password: passwordHash,
        created_at: now,
        updated_at: now,
      })),
    )

    /**
     * One organization per user, through the same function a real signup calls.
     *
     * Hand-writing the `organizations` and `organization_members` rows would produce a shape that passes
     * every foreign key and still differs from production — the function also validates the id pattern and
     * seeds whatever a personal organization is defined to contain. A fixture that skips it measures a
     * database state the application never creates.
     */
    const organizationIds: string[] = []
    for (const userId of userIds) {
      const organizationId = personalOrganizationId(userId)
      organizationIds.push(organizationId)
      await sql`select bootstrap_personal_organization(
        ${userId}, ${organizationId}, ${personalOrganizationSlug(userId)}, ${`${organizationId}:owner`}
      )`
    }
    written.organizations = organizationIds.length
    log(`  ${written.organizations} organizations bootstrapped`)

    const identityIds = Array.from({ length: counts.builderIdentities }, (_, i) =>
      fixtureId(runId, 'bi', String(i).padStart(3, '0')),
    )
    written.builder_identities = await insertBatched(
      sql,
      'builder_identities',
      identityIds.map((id, i) => ({
        id,
        source: 'github',
        source_id: id,
        username: `load-builder-${i}`,
        display_name: `Load Builder ${i}`,
        avatar_url: `https://avatars.load.local/${i}.png`,
        profile_url: `https://load.local/builder/${i}`,
        followers_count: 100 + i,
        language: i % 3 === 0 ? 'TypeScript' : i % 3 === 1 ? 'Go' : 'Rust',
        kind: 'person',
        first_seen_at: now,
        last_seen_at: new Date(now.getTime() - i * 60_000),
        created_at: now,
        updated_at: now,
      })),
    )

    const builderRows: Record<string, unknown>[] = []
    const alertRows: Record<string, unknown>[] = []
    const triggerRows: Record<string, unknown>[] = []
    const savedQueryRows: Record<string, unknown>[] = []
    const sprintRows: Record<string, unknown>[] = []
    const sprintResultRows: Record<string, unknown>[] = []
    const manifestUsers: LoadFixtureUser[] = []

    for (const [index, organizationId] of organizationIds.entries()) {
      const userId = userIds[index]
      const ordinal = String(index).padStart(4, '0')
      const sprintId = fixtureId(runId, 'sp', ordinal)
      manifestUsers.push({ userId, email: `${userId}@load.local`, organizationId, sprintId })

      for (let n = 0; n < counts.builderRowsPerOrganization; n += 1) {
        builderRows.push({
          id: fixtureId(runId, 'ob', `${ordinal}_${n}`),
          organization_id: organizationId,
          // Rotated rather than random, so two seeds of the same size touch the same identities and a
          // difference between two runs is never the fixture.
          builder_identity_id: identityIds[(index * counts.builderRowsPerOrganization + n) % identityIds.length],
          creator_user_id: userId,
          created_at: new Date(now.getTime() - n * 3_600_000),
          updated_at: now,
        })
      }

      for (let n = 0; n < counts.alertsPerOrganization; n += 1) {
        alertRows.push({
          id: fixtureId(runId, 'al', `${ordinal}_${n}`),
          organization_id: organizationId,
          user_id: userId,
          name: `Load alert ${n}`,
          keywords: JSON.stringify(['typescript', 'postgres']),
          enabled: true,
          created_at: now,
        })
      }

      for (let n = 0; n < counts.triggersPerOrganization; n += 1) {
        triggerRows.push({
          id: fixtureId(runId, 'tr', `${ordinal}_${n}`),
          organization_id: organizationId,
          alert_id: fixtureId(runId, 'al', `${ordinal}_0`),
          user_id: userId,
          event_type: 'new_match',
          matched_at: new Date(now.getTime() - n * 600_000),
          // The first N stay unread, so `unread-count` returns a stable non-zero number.
          read_at: n < counts.unreadTriggersPerOrganization ? null : now,
        })
      }

      for (let n = 0; n < counts.savedQueriesPerOrganization; n += 1) {
        savedQueryRows.push({
          id: fixtureId(runId, 'sq', `${ordinal}_${n}`),
          organization_id: organizationId,
          user_id: userId,
          name: `Load query ${n}`,
          keywords: JSON.stringify(['typescript']),
          created_at: new Date(now.getTime() - n * 86_400_000),
          updated_at: now,
        })
      }

      sprintRows.push({
        id: sprintId,
        organization_id: organizationId,
        creator_user_id: userId,
        name: `Load sprint ${index}`,
        criteria: JSON.stringify({ keywords: ['typescript'] }),
        variants: JSON.stringify([{ name: 'baseline', keywords: ['typescript'] }]),
        status: 'completed',
        created_at: now,
        last_run_at: now,
        completed_at: now,
      })

      for (let n = 0; n < counts.sprintResultsPerOrganization; n += 1) {
        sprintResultRows.push({
          id: fixtureId(runId, 'sr', `${ordinal}_${n}`),
          organization_id: organizationId,
          sprint_id: sprintId,
          source: 'github',
          source_id: `${sprintId}_${n}`,
          profile: JSON.stringify({
            username: `load-builder-${n}`,
            displayName: `Load Builder ${n}`,
            profileUrl: `https://load.local/builder/${n}`,
            followersCount: 100 + n,
          }),
          matched_variant: 'baseline',
          score: 100 - n,
          created_at: new Date(now.getTime() - n * 60_000),
        })
      }
    }

    // Sprints before their results: `sprint_results` has a composite foreign key onto
    // `(organization_id, id)`, so the order here is a constraint and not a preference.
    written.organization_builders = await insertBatched(sql, 'organization_builders', builderRows)
    written.alerts = await insertBatched(sql, 'alerts', alertRows)
    written.alert_triggers = await insertBatched(sql, 'alert_triggers', triggerRows)
    written.saved_queries = await insertBatched(sql, 'saved_queries', savedQueryRows)
    written.sourcing_sprints = await insertBatched(sql, 'sourcing_sprints', sprintRows)
    written.sprint_results = await insertBatched(sql, 'sprint_results', sprintResultRows)

    /**
     * `ANALYZE` before handing the fixture over.
     *
     * A freshly bulk-loaded table has no statistics, so the planner guesses — and it guesses badly enough
     * to pick a sequential scan over the index the run is supposed to be measuring. Without this the first
     * minutes of every run describe a plan production would never use.
     */
    await sql.unsafe('analyze auth_users, organizations, organization_builders, alert_triggers, saved_queries, sourcing_sprints, sprint_results, builder_identities')

    const manifest: LoadFixtureManifest = {
      runId,
      seededAt: now.toISOString(),
      users: manifestUsers,
      counts: written,
    }
    const path = manifestPath(runId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    log(`  manifest written to ${path}`)
    for (const [table, count] of Object.entries(written)) log(`  ${table}: ${count}`)
    return manifest
  } finally {
    await sql.end({ timeout: 10 }).catch(() => undefined)
  }
}

/** Nothing runs on import — the integration check calls `seedLoadFixtures` directly. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedLoadFixtures({
    databaseUrl: process.env.LOAD_DATABASE_URL,
    runIdSuffix: process.env.LOAD_RUN_SUFFIX ?? 'seed',
  })
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      // The message only — a stack from `postgres` can carry the query, and a query can carry a value.
      console.error(`load seed failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      process.exit(1)
    })
}
