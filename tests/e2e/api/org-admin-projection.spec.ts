import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { e2eEnv } from '../harness/env'
import { readOrgAdminOverview } from '~/shared/lib/repositories/dashboard-organization-admin'

/**
 * The organization-admin overview projection, executed as the role that would run it (plan 57, Admin track).
 *
 * ## Why this is an e2e spec and not a unit test, emphatically
 *
 * This projection was marked done on 2026-08-07 with a detailed write-up, imported by nothing, and had never
 * executed a single query successfully. It threw `column "email_verified" does not exist` on the first call.
 *
 * Rewriting it surfaced three *more* problems, and every one of them was a **privilege** rather than a schema
 * mistake: `builderhunt_app` is not granted on `auth_users` (so no verification count), not granted on
 * `organization_invitations` (so no pending count — invitations belong to Better Auth under `builderhunt_auth`),
 * and `auth_users` has no sign-in timestamp at all (so no stale-admin map).
 *
 * A unit test connects as the superuser, which has every privilege — so all three would have passed, the
 * projection would have looked correct, and it would have thrown `permission denied` the first time a real request
 * ran it. That is the exact failure mode this repository has three defects on record for. The only way to know what
 * a tenant-scoped connection can read is to connect as the identity a tenant-scoped connection uses.
 *
 * ## And the tenant context is part of the calling contract
 *
 * The read cases run inside a transaction with `app.organization_id` set, because without it the member count comes
 * back empty even with rows seeded: `organization_members` is under RLS. A superuser connection would have returned
 * the rows regardless and hidden that requirement entirely.
 */
let database: Awaited<ReturnType<typeof acquireWorkerDatabase>>
let workerIndex: number
/** The app role — what a tenant dashboard request runs as, and the identity under test. */
let sql: Sql
/**
 * A privileged connection, used **only to seed**.
 *
 * `builderhunt_app` cannot insert into `organizations` either — Better Auth owns them under `builderhunt_auth`,
 * which is the fourth privilege boundary this rewrite ran into. Seeding through a role that has the privilege and
 * *reading* through the role that does not is the split that makes the read assertion mean something: if the read
 * needed a privilege it lacks, this spec fails where production would.
 */
let seed: Sql

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  expect(e2eEnv().E2E_MODE).toBe('true')
  workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  database = await acquireWorkerDatabase(workerIndex)
  // The app role, which is what a tenant dashboard request runs as.
  sql = postgres(database.urls.DATABASE_URL, { max: 2, prepare: false })
  // Same database, owner credentials. Derived from the app URL so the database name cannot drift apart.
  seed = postgres(database.urls.DATABASE_URL.replace(/\/\/[^:]+:[^@]+@/, '//postgres:postgres@'), {
    max: 1,
    prepare: false,
  })
})

test.afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => undefined)
  await seed?.end({ timeout: 5 }).catch(() => undefined)
  await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
})

const ABSENT_ORGANIZATION = '00000000-0000-4000-8000-000000000000'

test('every query executes as the app role, which is the whole point', async () => {
  /**
   * The assertion the previous version could not pass. Not "the numbers are right" — "the statements run at all",
   * as the role that would run them.
   */
  const overview = await readOrgAdminOverview(sql, {
    organizationId: ABSENT_ORGANIZATION,
    range: '24h',
    now: new Date(),
  })
  expect(overview.schemaVersion).toBe(1)
  expect(Object.keys(overview.sections)).toHaveLength(6)
})

test('the three sections with no source say `dependency-missing`, not zero', async () => {
  /**
   * `blocked_workflows` and `feature_adoption` exist in no form. `securityPosture` is the interesting one: its
   * dependency is a *privilege* — the unverified-admin count needs `auth_users`, which the app role is deliberately
   * not granted, and granting it to populate a dashboard tile would trade a real boundary for a number.
   *
   * `empty` would be wrong for all three. Empty means "nothing to show", which a reader takes as "no blocked
   * workflows" — a healthy workspace. `dependency-missing` says the feature is not there.
   */
  const overview = await readOrgAdminOverview(sql, {
    organizationId: ABSENT_ORGANIZATION,
    range: '24h',
    now: new Date(),
  })
  for (const name of ['blockedWorkflows', 'featureAdoption', 'securityPosture'] as const) {
    const section = overview.sections[name]
    expect(section.state, name).toBe('unavailable')
    expect(section, name).toMatchObject({ reason: 'dependency-missing' })
  }
})

test('an organization with no rows is `empty`, which is a different sentence from `unavailable`', async () => {
  // The distinction the envelope exists for, and it is the one this plan is about: a workspace with no members is
  // not a workspace whose member count could not be read.
  const overview = await readOrgAdminOverview(sql, {
    organizationId: ABSENT_ORGANIZATION,
    range: '24h',
    now: new Date(),
  })
  expect(overview.sections.members.state).toBe('empty')
  expect(overview.sections.billing.state).toBe('empty')
  expect(overview.sections.privacyRequests.state).toBe('empty')
})

test('reads real counts and a seat cap when there is something to read', async () => {
  /**
   * Seeded through the privileged connection, because the app role cannot insert an organization — Better Auth owns
   * them. The *read* still goes through the app role, which is the assertion: a projection that needed a privilege
   * this connection lacks fails here rather than on the first real request.
   */
  const organizationId = '11111111-1111-4111-8111-111111111111'
  const users = ['u1', 'u2', 'u3'].map((suffix) => `user-${organizationId}-${suffix}`)

  /**
   * The accounts come first, because `organization_members.user_id` has a foreign key to `auth_users`.
   *
   * Worth stating rather than just satisfying: that constraint is why the projection's member count is trustworthy
   * at all — a membership row cannot name somebody who does not exist, so `count(*)` over memberships is a count of
   * real people without needing a join the app role is not allowed to make.
   */
  for (const userId of users) {
    await seed`
      INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Probe', ${`${userId}@example.test`}, true, now(), now())
      ON CONFLICT (id) DO NOTHING
    `
  }

  await seed`
    INSERT INTO organizations (id, name, slug, created_at)
    VALUES (${organizationId}, 'Probe', ${`probe-${workerIndex}`}, now())
    ON CONFLICT (id) DO NOTHING
  `
  for (const [index, userId] of users.entries()) {
    await seed`
      INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
      VALUES (${`m-${userId}`}, ${organizationId}, ${userId}, ${index === 0 ? 'owner' : index === 1 ? 'admin' : 'member'}, now())
      ON CONFLICT (id) DO NOTHING
    `
  }
  await seed`
    INSERT INTO organization_entitlements (organization_id, tier, status, seat_limit, current_period_end)
    VALUES (${organizationId}, 'pro', 'active', 3, now() + interval '10 days')
    ON CONFLICT (organization_id) DO UPDATE SET seat_limit = 3
  `

  /**
   * Read inside a transaction with the tenant context set, which is how production calls it.
   *
   * Without it the member count came back as `empty` even with three rows seeded — `organization_members` is under
   * RLS scoped to `app.organization_id`, so the app role sees nothing until a request sets it. That is the isolation
   * working, and it is worth having a case that depends on it: a projection that returned rows *without* the context
   * would mean the policy had stopped applying.
   *
   * `set_config(..., true)` is transaction-local, so the context cannot leak to the next query on this pooled
   * connection — which is the same reason `withTenantContext` uses a transaction rather than a session variable.
   */
  const overview = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`
    return readOrgAdminOverview(tx as unknown as Sql, { organizationId, range: '24h', now: new Date() })
  })

  const members = overview.sections.members
  expect(members.state).toBe('ready')
  expect(members).toMatchObject({ data: { total: 3, byRole: { owner: 1, admin: 1, member: 1 }, seatLimit: 3 } })

  /**
   * Three members against a three-seat limit is at the cap, so the boolean is true.
   *
   * A boolean rather than a percentage: "87 % of your seats" invites arithmetic on a number the reader cannot act
   * on precisely, and the seat count is already in the members section for anybody who wants to do it.
   */
  const billing = overview.sections.billing
  expect(billing.state).toBe('ready')
  expect(billing).toMatchObject({ data: { tier: 'pro', status: 'active', approachingSeatCap: true, seatLimit: 3 } })
})

test('carries none of the eight forbidden markers, whatever it read', async () => {
  /**
   * The privacy contract, asserted by grep on the serialized output rather than by reading the code — which is how
   * `admin-contracts.ts` describes the guarantee. Structural rather than careful: every query here groups and
   * counts, so there is no identity column to leak.
   */
  const organizationId = '11111111-1111-4111-8111-111111111111'
  const overview = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`
    return readOrgAdminOverview(tx as unknown as Sql, { organizationId, range: '24h', now: new Date() })
  })
  const serialized = JSON.stringify(overview)
  for (const marker of [
    'memberEmail',
    'candidateEmail',
    'productivityScore',
    'sessionDetail',
    'individualAdoption',
    'searchContent',
    'noteContent',
  ]) {
    expect(serialized, marker).not.toContain(marker)
  }
  // No user id either, which is not on the marker list and is the thing a members projection is most likely to leak.
  expect(serialized).not.toContain('user-11111111')
})
