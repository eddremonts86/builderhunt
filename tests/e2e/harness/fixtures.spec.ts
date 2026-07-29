/**
 * Wave 1 Task 2 — principals, organizations, entitlements, storage states,
 * and clock fixtures.
 *
 * Proves the fixture layer can mint every principal the product knows
 * (anonymous, unverified, verified, member, organization admin, owner,
 * platform admin), that each authenticated principal's storage state
 * authenticates through the real `/api/auth/get-session` endpoint of a
 * per-worker app server, and that each organization role resolves through
 * the real authorization layer (`requireTenantPrincipal` via
 * `GET /api/organizations/team`, `requirePlatformAdminPrincipal` via
 * `GET /api/admin/users`).
 *
 * Organizations always receive explicit free/pro/team entitlements with
 * configurable seat limits; clock-sensitive fixture rows derive every
 * timestamp from the fixed E2E clock (`E2E_FIXED_TIME`).
 *
 * Real sign-up remains a separate regression path — fixtures use the real
 * sign-up/sign-in/organization APIs where a product flow exists, and only
 * write the database directly where none does (email verification has no
 * product flow; membership without email delivery has none either).
 */
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './load-env'

// Pure-Node spec — no vite/vitest to auto-load .env, so direct-DB
// connections need DATABASE_MIGRATION_URL from .env.
loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './database'
import { acquireWorkerRedis, dropWorkerRedisNamespace, redis } from './cache'
import { startWorkerServer, stopWorkerServer } from './server'
import { e2eEnv } from './env'
import {
  ENTITLEMENT_TIERS,
  SEAT_LIMIT_MAX,
  SEAT_LIMIT_MIN,
  assertSeatLimit,
  organizationRoleForKind,
  type EntitlementTier,
} from './roles'
import { ensureFixedTimeEnv, fixedClock, fixedClockFromEnv, type FixedClock } from './clock'
import { getSession, newApiContext, sessionFromStorageState } from './auth'
import {
  createAnonymousPrincipal,
  createMemberPrincipal,
  createOwnerPrincipal,
  createUnverifiedPrincipal,
  createVerifiedPrincipal,
  cleanupPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './fixtures/principals'
import {
  createOrganizationFixture,
  readEntitlement,
  type OrganizationFixture,
} from './fixtures/organizations'
import { pastDueEntitlement, seedEntitlement, trialingEntitlement } from './fixtures/billing'
import { seedConsent, seedDataExportRequest, seedDeletionRequest } from './fixtures/privacy'
import { seedTrackedBuilder } from './fixtures/builders'
import { seedEnrichmentJob } from './fixtures/workers'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
  type PlatformAdminSeed,
} from './fixtures/platform-admin'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  clock: FixedClock
  adminSeed: PlatformAdminSeed
  anonymous: Principal
  unverified: Principal
  verified: Principal
  owner: Principal
  admin: Principal
  member: Principal
  platformAdmin: Principal
  sharedOrganization: OrganizationFixture
}

let harness: Harness
let toreDown = false

test.beforeAll(async () => {
  // Disposable DB creation + migrations + a fresh vite dev server boot all
  // happen here — far beyond the default 30s test timeout.
  test.setTimeout(300_000)

  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')
  expect(env.E2E_FIXED_TIME).toBeTruthy()

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  // Platform admin is env-allow-listed (`ADMIN_USER_IDS`), so the id must be
  // reserved and registered BEFORE the app server process is spawned.
  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}`)
  registerPlatformAdminEnv(adminSeed)

  let server: Awaited<ReturnType<typeof startWorkerServer>>
  let sql: Sql | undefined
  try {
    server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}` }
    const clock = fixedClockFromEnv()

    const anonymous = await createAnonymousPrincipal(ctx)
    const unverified = await createUnverifiedPrincipal(ctx)
    const verified = await createVerifiedPrincipal(ctx)
    const { principal: owner, organization: sharedOrganization } = await createOwnerPrincipal(ctx, {
      tier: 'team',
      seatLimit: 5,
      clock,
    })
    const admin = await createMemberPrincipal(ctx, sharedOrganization.organizationId, 'admin')
    const member = await createMemberPrincipal(ctx, sharedOrganization.organizationId, 'member')
    const platformAdmin = await createPlatformAdminPrincipal(ctx, adminSeed)

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      clock,
      adminSeed,
      anonymous,
      unverified,
      verified,
      owner,
      admin,
      member,
      platformAdmin,
      sharedOrganization,
    }
  } catch (error) {
    // Failing mid-setup must not leak the worker's server, database, or
    // Redis namespace — `harness` was never assigned, so the afterAll
    // teardown would have nothing to clean.
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})


test.afterAll(async () => {
  if (toreDown) return
  await teardown()
})

async function teardown(): Promise<void> {
  toreDown = true
  const h = harness
  if (!h) return
  for (const principal of [h.anonymous, h.unverified, h.verified, h.owner, h.admin, h.member, h.platformAdmin]) {
    await disposePrincipal(principal).catch(() => undefined)
  }
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  // The app server's connection pools may take a beat to die with the
  // process — terminate any straggler backends so DROP DATABASE cannot
  // fail with "being accessed by other users".
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
}

test('anonymous principal has no session and is rejected by the tenant authorization layer', async () => {
  const { anonymous, baseURL } = harness
  expect(anonymous.kind).toBe('anonymous')
  expect(anonymous.userId).toBeNull()
  expect(anonymous.storageState).toEqual({ cookies: [], origins: [] })
  expect(organizationRoleForKind('anonymous')).toBeNull()

  const session = await sessionFromStorageState(baseURL, { cookies: [], origins: [] })
  expect(session).toBeNull()

  const api = await newApiContext(baseURL)
  try {
    const response = await api.get('/api/organizations/team')
    expect(response.status()).toBe(401)
  } finally {
    await api.dispose()
  }
})

test('unverified principal authenticates via storage state with an unverified email', async () => {
  const { unverified, baseURL, sql } = harness
  expect(unverified.userId).toBeTruthy()
  const session = await sessionFromStorageState(baseURL, unverified.storageState!)
  expect(session?.userId).toBe(unverified.userId)
  expect(session?.emailVerified).toBe(false)
  const rows = await sql<{ email_verified: boolean }[]>`
    select email_verified from auth_users where id = ${unverified.userId!}
  `
  expect(rows).toHaveLength(1)
  expect(rows[0].email_verified).toBe(false)
})

test('verified principal authenticates via storage state with a verified email', async () => {
  const { verified, baseURL, sql } = harness
  const session = await sessionFromStorageState(baseURL, verified.storageState!)
  expect(session?.userId).toBe(verified.userId)
  expect(session?.emailVerified).toBe(true)
  const rows = await sql<{ email_verified: boolean }[]>`
    select email_verified from auth_users where id = ${verified.userId!}
  `
  expect(rows[0].email_verified).toBe(true)
  // Signing up gave the user a personal workspace where they are owner —
  // the session must be scoped to it.
  expect(session?.activeOrganizationId).toBe(verified.organizationId)
})

test('owner principal resolves through the real tenant authorization layer as owner', async () => {
  const { owner, sharedOrganization } = harness
  expect(owner.role).toBe('owner')
  expect(owner.organizationId).toBe(sharedOrganization.organizationId)
  const response = await owner.api!.get('/api/organizations/team')
  expect(response.status()).toBe(200)
  const snapshot = await response.json()
  expect(snapshot.viewerRole).toBe('owner')
  expect(snapshot.organization.id).toBe(sharedOrganization.organizationId)
  expect(snapshot.seatUsage.limit).toBe(sharedOrganization.seatLimit)
})

test('organization admin principal resolves as admin of the shared organization', async () => {
  const { admin, sharedOrganization } = harness
  expect(admin.role).toBe('admin')
  const session = await getSession(admin.api!)
  expect(session?.activeOrganizationId).toBe(sharedOrganization.organizationId)
  const response = await admin.api!.get('/api/organizations/team')
  expect(response.status()).toBe(200)
  const snapshot = await response.json()
  expect(snapshot.viewerRole).toBe('admin')
  expect(snapshot.organization.id).toBe(sharedOrganization.organizationId)
})

test('member principal resolves as member of the shared organization', async () => {
  const { member, sharedOrganization } = harness
  expect(member.role).toBe('member')
  const session = await getSession(member.api!)
  expect(session?.activeOrganizationId).toBe(sharedOrganization.organizationId)
  const response = await member.api!.get('/api/organizations/team')
  expect(response.status()).toBe(200)
  const snapshot = await response.json()
  expect(snapshot.viewerRole).toBe('member')
})

test('every authenticated principal storage state authenticates through /api/auth/get-session', async () => {
  const { baseURL } = harness
  const principals = [
    harness.unverified,
    harness.verified,
    harness.owner,
    harness.admin,
    harness.member,
    harness.platformAdmin,
  ]
  for (const principal of principals) {
    expect(principal.storageState, `${principal.kind} storage state`).toBeTruthy()
    const session = await sessionFromStorageState(baseURL, principal.storageState!)
    expect(session?.userId, `${principal.kind} session`).toBe(principal.userId)
    expect(session?.activeOrganizationId, `${principal.kind} active organization`).toBe(
      principal.organizationId,
    )
  }
})

test('organizations always receive explicit free/pro/team entitlements with configurable seat limits', async () => {
  const { ctx, verified, clock, sql } = harness
  const seatLimits: Record<EntitlementTier, number> = { free: SEAT_LIMIT_MIN, pro: 3, team: SEAT_LIMIT_MAX }
  for (const tier of ENTITLEMENT_TIERS) {
    const organization = await createOrganizationFixture(ctx, verified, {
      tier,
      seatLimit: seatLimits[tier],
      clock,
      keepCurrentActiveOrganization: true,
    })
    const entitlement = await readEntitlement(sql, organization.organizationId)
    expect(entitlement, `${tier} entitlement row`).toBeTruthy()
    expect(entitlement!.tier).toBe(tier)
    expect(entitlement!.status).toBe('active')
    expect(entitlement!.seatLimit).toBe(seatLimits[tier])
  }
  // Seat limits are configurable only inside the schema's hard bounds.
  expect(() => assertSeatLimit(SEAT_LIMIT_MIN - 1)).toThrow()
  expect(() => assertSeatLimit(SEAT_LIMIT_MAX + 1)).toThrow()
})

test('billing fixtures seed deterministic trialing and past_due entitlement states from the fixed clock', async () => {
  const { ctx, verified, clock, sql } = harness
  const organization = await createOrganizationFixture(ctx, verified, {
    tier: 'pro',
    seatLimit: 2,
    clock,
    keepCurrentActiveOrganization: true,
  })

  const trialing = trialingEntitlement(organization.organizationId, 'pro', 2, clock)
  await seedEntitlement(sql, trialing)
  const trialingRow = await readEntitlement(sql, organization.organizationId)
  expect(trialingRow!.status).toBe('trialing')
  expect(trialingRow!.trialEndsAt?.getTime()).toBe(clock.plus({ days: 14 }).getTime())

  const pastDue = pastDueEntitlement(organization.organizationId, 'pro', 2, clock)
  await seedEntitlement(sql, pastDue)
  const pastDueRow = await readEntitlement(sql, organization.organizationId)
  expect(pastDueRow!.status).toBe('past_due')
  expect(pastDueRow!.currentPeriodEnd?.getTime()).toBe(clock.minus({ days: 1 }).getTime())
  expect(pastDueRow!.currentPeriodStart?.getTime()).toBe(clock.minus({ days: 31 }).getTime())
})

test('fixed-time clock state is deterministic and derived from E2E_FIXED_TIME', async () => {
  const { clock } = harness
  const iso = process.env.E2E_FIXED_TIME!
  expect(clock.iso).toBe(new Date(iso).toISOString())
  expect(clock.now().getTime()).toBe(new Date(iso).getTime())
  // Two reads never drift — the clock is fixed, not "now at first call".
  expect(clock.now().getTime()).toBe(clock.now().getTime())
  expect(clock.plus({ days: 1 }).getTime()).toBe(clock.now().getTime() + 24 * 60 * 60 * 1000)
  expect(clock.minus({ hours: 2 }).getTime()).toBe(clock.now().getTime() - 2 * 60 * 60 * 1000)
  // Same input → same clock, independent of process state.
  expect(fixedClock(iso).now().getTime()).toBe(clock.now().getTime())
  expect(() => fixedClock('not-a-timestamp')).toThrow()
})

test('platform admin principal resolves through the real platform-admin authorization layer', async () => {
  const { platformAdmin, member, adminSeed, baseURL } = harness
  expect(platformAdmin.kind).toBe('platform-admin')
  expect(platformAdmin.userId).toBe(adminSeed.userId)

  const allowed = await platformAdmin.api!.get('/api/admin/users')
  expect(allowed.status()).toBe(200)

  // A tenant role is never a platform role — the same endpoint rejects an
  // organization member and an anonymous caller.
  const denied = await member.api!.get('/api/admin/users')
  expect(denied.status()).toBe(403)
  const anonymousApi = await newApiContext(baseURL)
  try {
    const unauthenticated = await anonymousApi.get('/api/admin/users')
    expect(unauthenticated.status()).toBe(401)
  } finally {
    await anonymousApi.dispose()
  }
})

test('privacy fixtures seed consent, export, and deletion rows for a principal', async () => {
  const { sql, verified, clock } = harness
  const consent = await seedConsent(sql, {
    userId: verified.userId!,
    document: 'tos',
    version: 'v1.0',
    acceptedAt: clock.now(),
  })
  const exportRequest = await seedDataExportRequest(sql, {
    userId: verified.userId!,
    status: 'ready',
    expiresAt: clock.plus({ days: 7 }),
  })
  const deletionRequest = await seedDeletionRequest(sql, {
    userId: verified.userId!,
    gracePeriodEndsAt: clock.plus({ days: 30 }),
  })

  const consents = await sql<{ document: string; version: string; accepted_at: Date }[]>`
    select document, version, accepted_at from user_consents where id = ${consent.id}
  `
  expect(consents).toHaveLength(1)
  expect(consents[0].document).toBe('tos')
  expect(consents[0].accepted_at.getTime()).toBe(clock.now().getTime())

  const exports = await sql<{ status: string; expires_at: Date }[]>`
    select status, expires_at from data_export_requests where id = ${exportRequest.id}
  `
  expect(exports[0].status).toBe('ready')
  expect(exports[0].expires_at.getTime()).toBe(clock.plus({ days: 7 }).getTime())

  const deletions = await sql<{ status: string; grace_period_ends_at: Date }[]>`
    select status, grace_period_ends_at from deletion_requests where id = ${deletionRequest.id}
  `
  expect(deletions[0].status).toBe('pending')
  expect(deletions[0].grace_period_ends_at.getTime()).toBe(clock.plus({ days: 30 }).getTime())
})

test('builder and worker fixtures seed organization-scoped rows', async () => {
  const { ctx, sql, owner, verified, sharedOrganization, clock } = harness
  const tracked = await seedTrackedBuilder(ctx, {
    organizationId: sharedOrganization.organizationId,
    creatorUserId: owner.userId!,
  })
  const job = await seedEnrichmentJob(sql, {
    organizationId: sharedOrganization.organizationId,
    builderIdentityId: tracked.builderIdentityId,
    requestedByUserId: owner.userId!,
    availableAt: clock.now(),
  })

  const builders = await sql<{ organization_id: string; status: string }[]>`
    select organization_id, status from organization_builders where id = ${tracked.organizationBuilderId}
  `
  expect(builders).toHaveLength(1)
  expect(builders[0].organization_id).toBe(sharedOrganization.organizationId)
  expect(builders[0].status).toBe('tracked')

  const jobs = await sql<{ organization_id: string; status: string; available_at: Date }[]>`
    select organization_id, status, available_at from enrichment_jobs where id = ${job.jobId}
  `
  expect(jobs).toHaveLength(1)
  expect(jobs[0].organization_id).toBe(sharedOrganization.organizationId)
  expect(jobs[0].status).toBe('queued')
  expect(jobs[0].available_at.getTime()).toBe(clock.now().getTime())

  // Organization scoping: none of these rows leak into another org.
  const foreign = await sql<{ count: string }[]>`
    select count(*) as count from organization_builders
    where builder_identity_id = ${tracked.builderIdentityId}
      and organization_id <> ${sharedOrganization.organizationId}
  `
  expect(Number(foreign[0].count)).toBe(0)
})

test('cleanup removes only the targeted fixture data', async () => {
  const { ctx, sql, owner, verified, sharedOrganization, clock } = harness
  const probe = await createVerifiedPrincipal(ctx, 'cleanup-probe')
  await seedConsent(sql, {
    userId: probe.userId!,
    document: 'privacy',
    version: 'v1.0',
    acceptedAt: clock.now(),
  })
  const probeUserId = probe.userId!
  const probeOrganizationIds = [...probe.ownedOrganizationIds]
  expect(probeOrganizationIds.length).toBeGreaterThan(0)

  await cleanupPrincipal(ctx, probe)

  // The probe's rows are gone…
  const users = await sql<{ id: string }[]>`select id from auth_users where id = ${probeUserId}`
  expect(users).toHaveLength(0)
  const organizations = await sql<{ id: string }[]>`
    select id from organizations where id in ${sql(probeOrganizationIds)}
  `
  expect(organizations).toHaveLength(0)
  const consents = await sql<{ id: string }[]>`select id from user_consents where user_id = ${probeUserId}`
  expect(consents).toHaveLength(0)

  // …while every other principal's data survives untouched.
  const surviving = await sql<{ id: string }[]>`
    select id from auth_users where id in ${sql([owner.userId!, verified.userId!])}
  `
  expect(surviving).toHaveLength(2)
  const org = await sql<{ id: string }[]>`
    select id from organizations where id = ${sharedOrganization.organizationId}
  `
  expect(org).toHaveLength(1)
  // Live sessions still authenticate — cleanup never truncates shared tables.
  const session = await getSession(owner.api!)
  expect(session?.userId).toBe(owner.userId)
})

test('final worker teardown drops the database and clears the Redis namespace', async () => {
  test.setTimeout(120_000)
  const { databaseName, redisPrefix } = harness

  const before = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    const rows = await before<{ datname: string }[]>`
      select datname from pg_database where datname = ${databaseName}
    `
    expect(rows).toHaveLength(1)
  } finally {
    await before.end({ timeout: 5 })
  }

  await teardown()

  const after = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    const rows = await after<{ datname: string }[]>`
      select datname from pg_database where datname = ${databaseName}
    `
    expect(rows).toHaveLength(0)
  } finally {
    await after.end({ timeout: 5 })
  }

  const client = await redis.client(redisPrefix)
  try {
    const keys = await client.keys(`${redisPrefix}*`)
    expect(keys).toHaveLength(0)
  } finally {
    await client.quit()
  }
})
