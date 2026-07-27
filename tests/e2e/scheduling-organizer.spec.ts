/**
 * The organizer's side of scheduling (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Build organizer
 * scheduling UI"). The candidate's side already has
 * `src/routes/schedule/$invitationId.tsx` and its own coverage; this is the
 * half that starts on a tracked builder's profile.
 *
 * `SCHEDULING_ENABLED` defaults to `false` and is set here **before the worker
 * server is spawned**, never left to a developer's `.env`. The semantic-search
 * spec learned that the expensive way: it passes locally through a real
 * provider a laptop happens to have, and on a runner it silently exercises a
 * different path. A test that only works where someone's dotenv agrees is not
 * a gate.
 *
 * The invitation itself is created through the real API rather than by driving
 * the composer end to end, because what is worth pinning here is the panel's
 * state machine — the list, the status transitions, and the revoke — not the
 * form's field wiring, which its own unit tests already cover.
 */
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import {
  createOwnerPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './harness/fixtures/principals'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { uniqueId } from './harness/ids'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  owner: Principal
  organization: OrganizationFixture
  /** `organization_builders.id` — the profile's `trackedId`, which the panel needs. */
  trackedBuilderId: string
  /** `builder_identities.id` — what the profile route is addressed by. */
  identityId: string
  builderName: string
}

let harness: Harness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  // Before `startWorkerServer`: the app process inherits process.env at spawn.
  process.env.SCHEDULING_ENABLED = 'true'

  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}sched` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, {
      tier: 'team',
      seatLimit: 5,
      clock,
    })

    // A tracked builder: the identity, the canonical tracking row the panel
    // keys off, and the legacy row the profile route's SSR head still reads.
    const identityId = uniqueId('sched-identity')
    const trackedBuilderId = uniqueId('sched-tracked')
    const username = `sched-${uniqueId('u').slice(-8)}`
    const builderName = 'E2E Scheduling Builder'

    await sql`
      insert into builder_identities (id, source, source_id, username, display_name, profile_url, created_at, updated_at)
      values (${identityId}, 'github', ${username}, ${username}, ${builderName},
              ${`https://e2e.test/github/${username}`}, now(), now())
    `
    await sql`
      insert into organization_builders (id, organization_id, builder_identity_id, creator_user_id)
      values (${trackedBuilderId}, ${organization.organizationId}, ${identityId}, ${owner.userId!})
    `
    await sql`
      insert into builders (id, organization_id, user_id, source, source_id, username, display_name, profile_url, created_at, updated_at)
      values (${trackedBuilderId}, ${organization.organizationId}, ${owner.userId!}, 'github',
              ${username}, ${username}, ${builderName}, ${`https://e2e.test/github/${username}`}, now(), now())
    `

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      owner,
      organization,
      trackedBuilderId,
      identityId,
      builderName,
    }

    await fetch(`${server.baseURL}/`).then((r) => r.text()).catch(() => undefined)
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await disposePrincipal(h.owner).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${h.databaseName} and pid <> pg_backend_pid()
    `
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await dropWorkerDatabase(h.workerIndex, h.databaseName)
  await dropWorkerRedisNamespace(h.redisPrefix)
})

/** Creates an invitation through the real API and returns its id. */
async function createInvitation(roleTitle: string): Promise<string> {
  const response = await harness.owner.api!.post('/api/scheduling/invitations', {
    data: {
      candidateEmail: `cand-${uniqueId('c').slice(-8)}@test.invalid`,
      roleTitle,
      roleContext: 'Backend platform work, mostly Postgres and tenancy.',
      durationMinutes: 30,
      timezone: 'Europe/Copenhagen',
      modality: 'remote_call',
      meetingUrl: 'https://meet.test.invalid/e2e',
      organizationBuilderId: harness.trackedBuilderId,
    },
  })
  expect(response.status(), await response.text()).toBeLessThan(400)
  const body = await response.json() as { invitationId?: string; invitation?: { invitationId?: string } }
  const id = body.invitationId ?? body.invitation?.invitationId
  expect(id, 'the create response carries an invitation id').toBeTruthy()
  return id!
}

test('the API is reachable and scheduling is switched on for this run', async () => {
  // A 503 here means `SCHEDULING_ENABLED` did not reach the app process, and
  // every assertion below would fail for that reason rather than a real one.
  const response = await harness.owner.api!.get('/api/scheduling/invitations')
  expect(response.status(), 'scheduling must be enabled — see the note at the top of this file')
    .toBe(200)
})

test('an issued invitation appears on the builder profile and can be revoked', async ({ browser }) => {
  const roleTitle = `E2E Role ${uniqueId('r').slice(-6)}`
  const invitationId = await createInvitation(roleTitle)

  // The organizer's own session: the panel asks `/api/scheduling/invitations`
  // on mount and collapses on anything but a 200, so an anonymous page hides
  // it and the assertions below would fail for the wrong reason.
  const context = await browser.newContext({ storageState: harness.owner.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  // The public profile mounts several account-scoped cards that answer 401/503
  // for any session without the matching provider or entitlement; they are not
  // what this test is about. See public-content.spec.ts for the same list.
  for (let i = 0; i < 8; i++) guard.allowExpectedFailure(/status of (401|403|503)/)

  try {
    // The profile route is addressed by the shared identity id; the DTO then
    // hands the panel the organization's own `trackedId` for that builder.
    await gotoHydrated(page, `${harness.baseURL}/builders/${harness.identityId}`)
    await dismissOverlays(page)

    const panel = page.getByRole('heading', { name: /invite to interview/i })
    await expect(panel, 'the invite panel renders for a tracked builder').toBeVisible()

    const row = page.getByTestId('invitation-status-row').filter({ hasText: roleTitle })
    await expect(row, 'the invitation just created is listed').toBeVisible()

    await row.getByRole('button', { name: /revoke/i }).click()
    await expect(row, 'the row reflects the revoked state without a reload')
      .toContainText(/revoked/i)
  } finally {
    guard.dispose()
    await context.close()
  }

  // The transition is persisted, not just painted.
  const [stored] = await harness.sql<{ status: string }[]>`
    select status from scheduling_invitations where id = ${invitationId}
  `
  expect(stored?.status).toBe('revoked')
})

test('a stale version loses the revoke race', async () => {
  const invitationId = await createInvitation(`E2E Twice ${uniqueId('r').slice(-6)}`)

  const listed = await harness.owner.api!.get('/api/scheduling/invitations')
  const { invitations } = await listed.json() as { invitations: Array<{ invitationId: string; version: number }> }
  const version = invitations.find((i) => i.invitationId === invitationId)?.version
  expect(version, 'the invitation is listed with a version').toBeDefined()

  const first = await harness.owner.api!.post(`/api/scheduling/invitations/${invitationId}/revoke`, {
    data: { version, idempotencyKey: `revoke-${invitationId}-${version}` },
  })
  expect(first.status(), await first.text()).toBeLessThan(400)

  // The same version again, under a *different* idempotency key: replaying the
  // original key would legitimately succeed as a replay, which would say
  // nothing about concurrency. This is the second tab that read the invitation
  // before the first tab revoked it, and it has to lose — an optimistic-version
  // check that lets a stale writer through is one that could also resurrect a
  // terminal invitation.
  const stale = await harness.owner.api!.post(`/api/scheduling/invitations/${invitationId}/revoke`, {
    data: { version, idempotencyKey: `revoke-${invitationId}-stale-${uniqueId('k').slice(-6)}` },
  })
  expect(stale.status(), 'the stale version must be rejected').toBeGreaterThanOrEqual(400)

  const [stored] = await harness.sql<{ status: string }[]>`
    select status from scheduling_invitations where id = ${invitationId}
  `
  expect(stored?.status).toBe('revoked')
})
