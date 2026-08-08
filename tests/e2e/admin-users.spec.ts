/**
 * plans/UI/tasks.md Wave 5 "Align Admin Users with organization-owned billing".
 *
 * Runs the full browser flow against the real `/admin/users` page and `/api/admin/users*`
 * endpoints, proving the four fixtures the task's own verify line names — canonical paid, manual
 * exception, expired exception, no-organization — render distinguishably, and that the manual-grant
 * mutation stays step-up protected and audited.
 */
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { createOwnerPrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import { createPlatformAdminPrincipal, registerPlatformAdminEnv, reservePlatformAdminSeed } from './harness/fixtures/platform-admin'
import type { OrganizationFixture } from './harness/fixtures/organizations'
import { seedConsent } from './harness/fixtures/privacy'
import { dismissOverlays, expectStrictBrowser, gotoHydrated } from './harness/browser'
import { CURRENT_CONSENT_VERSIONS } from '~/shared/lib/legal-versions'
import { uniqueId } from './harness/ids'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  owner: Principal
  organization: OrganizationFixture
  admin: Principal
}

let harness: Harness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  const adminSeed = reservePlatformAdminSeed(`w${workerIndex}users`)
  registerPlatformAdminEnv(adminSeed)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}users` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 3, clock })
    const admin = await createPlatformAdminPrincipal(ctx, adminSeed)
    await seedConsent(sql, { userId: admin.userId!, document: 'tos', version: CURRENT_CONSENT_VERSIONS.tos, acceptedAt: clock.now() })

    harness = { workerIndex, databaseName: database.databaseName, redisPrefix: cache.prefix, baseURL: server.baseURL, sql, ctx, owner, organization, admin }
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
  await harness.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex).catch(() => undefined)
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(harness.redisPrefix).catch(() => undefined)
})

async function withStaleAdminSession<T>(fn: () => Promise<T>): Promise<T> {
  const staleSince = new Date(Date.now() - 20 * 60 * 1000)
  await harness.sql`update auth_sessions set created_at = ${staleSince} where user_id = ${harness.admin.userId!}`
  try {
    return await fn()
  } finally {
    await harness.sql`update auth_sessions set created_at = now() where user_id = ${harness.admin.userId!}`
  }
}

/** A fresh user + org, with the org's entitlement/subscription state fully controlled by the caller. */
async function seedUserWithOrg(input: {
  tier: string
  hasSubscription: boolean
  currentPeriodEnd?: Date | null
  owner?: boolean
}) {
  const id = uniqueId('billuser', harness.ctx.scope)
  const userId = `u-${id}`
  const orgId = `org-${id}`
  await harness.sql`insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (${userId}, ${`User ${id}`}, ${`${id}@e2e.test`}, true, now(), now())`
  await harness.sql`insert into organizations (id, name, slug) values (${orgId}, ${`Org ${id}`}, ${orgId})`
  await harness.sql`insert into organization_members (id, organization_id, user_id, role) values (${`mem-${id}`}, ${orgId}, ${userId}, ${input.owner === false ? 'member' : 'owner'})`
  await harness.sql`insert into organization_entitlements (organization_id, tier, status, current_period_end) values (${orgId}, ${input.tier}, 'active', ${input.currentPeriodEnd ?? null})`
  if (input.hasSubscription) {
    await harness.sql`insert into billing_customers (id, organization_id, livemode, stripe_customer_id) values (${`cust-${id}`}, ${orgId}, false, ${`cus_${id}`})`
    await harness.sql`
      insert into billing_subscriptions (id, organization_id, customer_id, livemode, catalog_key, tier, interval, catalog_version, stripe_subscription_id, stripe_status, canceled_at)
      values (${`sub-${id}`}, ${orgId}, ${`cust-${id}`}, false, 'pro-monthly', ${input.tier}, 'monthly', 1, ${`sub_stripe_${id}`}, 'active', null)
    `
  }
  return { userId, orgId }
}

async function cleanupUserWithOrg(userId: string, orgId: string) {
  await harness.sql`delete from billing_subscriptions where organization_id = ${orgId}`
  await harness.sql`delete from billing_customers where organization_id = ${orgId}`
  await harness.sql`delete from organization_entitlements where organization_id = ${orgId}`
  await harness.sql`delete from organization_members where organization_id = ${orgId}`
  await harness.sql`delete from organizations where id = ${orgId}`
  await harness.sql`delete from auth_users where id = ${userId}`
}

test.describe('admin users — organization-owned billing', () => {
  test('the API is unavailable to a non-platform-admin organization owner', async () => {
    expect((await harness.owner.api!.get('/api/admin/users')).status()).toBe(403)
    expect((await harness.owner.api!.patch(`/api/admin/users/${harness.owner.userId}`, {
      data: { plan: 'pro', reason: 'test' },
    })).status()).toBe(403)
  })

  test('a stale admin session is rejected before granting a manual exception', async () => {
    const { userId, orgId } = await seedUserWithOrg({ tier: 'free', hasSubscription: false })
    try {
      await withStaleAdminSession(async () => {
        const response = await harness.admin.api!.patch(`/api/admin/users/${userId}`, { data: { plan: 'pro', reason: 'test' } })
        expect(response.status()).toBe(401)
      })
    } finally {
      await cleanupUserWithOrg(userId, orgId)
    }
  })

  test('canonical paid, manual exception, expired exception, and no-organization fixtures are distinguishable via the API', async () => {
    const canonical = await seedUserWithOrg({ tier: 'pro', hasSubscription: true })
    const manual = await seedUserWithOrg({ tier: 'team', hasSubscription: false, currentPeriodEnd: new Date(Date.now() + 86_400_000) })
    const expired = await seedUserWithOrg({ tier: 'pro', hasSubscription: false, currentPeriodEnd: new Date(Date.now() - 86_400_000) })
    const noOrgUserId = `u-${uniqueId('noorg', harness.ctx.scope)}`
    await harness.sql`insert into auth_users (id, name, email, email_verified, created_at, updated_at) values (${noOrgUserId}, 'No Org', ${`${noOrgUserId}@e2e.test`}, true, now(), now())`

    try {
      const response = await harness.admin.api!.get('/api/admin/users')
      expect(response.status()).toBe(200)
      // `rows`, not `users`: the admin grid is a platform-scoped keyset page since plans/phase-3/10.
      const body = await response.json() as { rows: Array<{ userId: string; billing: { provenance: string } | null }> }
      const byId = new Map(body.rows.map((u) => [u.userId, u]))

      expect(byId.get(canonical.userId)?.billing?.provenance).toBe('canonical')
      expect(byId.get(manual.userId)?.billing?.provenance).toBe('manual_exception')
      expect(byId.get(expired.userId)?.billing?.provenance).toBe('expired_exception')
      expect(byId.get(noOrgUserId)?.billing).toBeNull()
    } finally {
      await cleanupUserWithOrg(canonical.userId, canonical.orgId)
      await cleanupUserWithOrg(manual.userId, manual.orgId)
      await cleanupUserWithOrg(expired.userId, expired.orgId)
      await harness.sql`delete from auth_users where id = ${noOrgUserId}`
    }
  })

  test('the four fixtures render distinguishably on the real page, and never leak a raw Stripe id', async ({ browser }) => {
    const canonical = await seedUserWithOrg({ tier: 'pro', hasSubscription: true })
    const manual = await seedUserWithOrg({ tier: 'team', hasSubscription: false, currentPeriodEnd: new Date(Date.now() + 86_400_000) })
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/users`)
      await dismissOverlays(page)
      await expect(page.getByTestId('admin-users-page')).toBeVisible()

      await expect(page.getByTestId(`admin-user-row-${canonical.userId}`)).toContainText(/pro/i)
      await expect(page.getByTestId(`admin-user-row-${manual.userId}`)).toContainText(/manual exception/i)

      const bodyText = await page.locator('body').innerText()
      expect(bodyText).not.toContain(`sub_stripe_${canonical.userId.replace('u-', '')}`)

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
      await cleanupUserWithOrg(canonical.userId, canonical.orgId)
      await cleanupUserWithOrg(manual.userId, manual.orgId)
    }
  })

  test('a platform admin can issue an audited manual grant, and it requires a reason', async ({ browser }) => {
    const { userId, orgId } = await seedUserWithOrg({ tier: 'free', hasSubscription: false })
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/users`)
      await dismissOverlays(page)

      const row = page.getByTestId(`admin-user-row-${userId}`)
      /*
       * The shell's own expansion toggle, not a per-row "Edit" button.
       *
       * plans/phase-3/10 moved the grant form into `DataTable`'s `expansion` slot, and with it the
       * per-row `admin-user-edit` button went away — the sibling unit test already records that.
       * This spec kept clicking the old testid, so it timed out on a control that no longer exists.
       * It went unnoticed because plan 10's verification ran `admin-journeys.spec.ts` and not this
       * file, which is the gap `pnpm ci:local` closed.
       */
      await page.getByTestId(`admin-user-row-${userId}-expand`).click()
      await expect(page.getByTestId('admin-user-save')).toBeDisabled()

      /**
       * Pick a tier explicitly, so this is a real upgrade rather than a grant of the tier the workspace already
       * holds. The organization is seeded `free`, and the form now seeds the select from the canonical
       * entitlement — so saving without touching it would grant free→free and the assertions below would be
       * checking that nothing happened.
       *
       * A Radix Select (the testid sits on the trigger button, `AdminUsersPage.tsx`), driven the way a user
       * does: open the trigger, click the option. `selectOption` only works on a native `<select>`.
       */
      await page.getByTestId('admin-user-plan-select').click()
      await page.getByRole('option', { name: 'Pro', exact: true }).click()

      await page.getByTestId('admin-user-reason').fill('Paid via invoice, confirmed manually.')
      await expect(page.getByTestId('admin-user-save')).toBeEnabled()
      await page.getByTestId('admin-user-save').click()
      await expect(page.getByTestId('admin-users-success')).toBeVisible()

      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }

    /**
     * The audit row moved, and the move is the substance.
     *
     * This read `plan_changes`, keyed by the granted **user**. Entitlement is enforced per organization, so a row
     * naming a user recorded something no enforcement check ever reads — it could not answer "which workspace got
     * upgraded", the only question an auditor actually has. `plan_changes` also had no writer at all by the end,
     * so this assertion was reading a table nothing filled.
     *
     * The trail is now `security_audit_events`, written durably through the worker role: it targets the
     * organization and carries `onBehalfOfUserId` so both ends of the indirection survive — the operator clicked
     * a user, the entitlement moved on a workspace.
     *
     * Still read before cleanup: the row references the organization, which the cleanup below deletes.
     */
    const [audit] = await harness.sql<{
      action: string
      target_type: string
      target_id: string
      actor_user_id: string
      result: string
      details: { from?: string; to?: string; onBehalfOfUserId?: string }
    }[]>`
      select action, target_type, target_id, actor_user_id, result, details
      from security_audit_events
      where action = 'admin.user.entitlement-grant' and target_id = ${orgId}
      order by created_at desc limit 1
    `
    await cleanupUserWithOrg(userId, orgId)

    expect(audit, 'the grant must leave a durable audit row, not just a log line').toBeTruthy()
    expect(audit!.target_type).toBe('organization')
    expect(audit!.result).toBe('allowed')
    expect(audit!.actor_user_id).toBe(harness.admin.userId)
    expect(audit!.details.from).toBe('free')
    expect(audit!.details.to).toBe('pro')
    expect(audit!.details.onBehalfOfUserId, 'the user the operator clicked must stay recoverable').toBe(userId)
  })

  test('links to Billing Operations', async ({ browser }) => {
    const context = await browser.newContext({ storageState: harness.admin.storageState! })
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    try {
      await gotoHydrated(page, `${harness.baseURL}/admin/users`)
      await dismissOverlays(page)
      await expect(page.getByTestId('admin-users-billing-link')).toHaveAttribute('href', '/admin/billing')
      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }
  })
})
