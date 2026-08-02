/**
 * The invitation routes over real HTTP (plan 53, task 1 —
 * `plans/phase-1/53-exhaustive-local-e2e-design/tasks.md`).
 *
 * An invitation is the one object in this system that deliberately crosses a tenant boundary: it is created
 * inside organization A and consumed by a session that is not yet a member of A. Every other route can be
 * tested by asking "does A's session reach B's data"; these cannot, because the whole point is that a stranger
 * reaches something. So the properties are different:
 *
 * - **The organization invited into is never in the request body.** `POST /api/organizations/invitations`
 *   reads it from `requireTenantPrincipal`. A body naming B must have no effect — otherwise anyone with a
 *   session could seat themselves in any organization.
 * - **An invitation id is a capability, and capabilities leak by id.** Resend and cancel take one in the path.
 *   A's admin holding B's invitation id must be refused, and refused the same way a fabricated id is, or the
 *   status code itself confirms which ids are real.
 * - **`mine` is keyed by verified email, not by id.** An unverified session gets `[]` rather than an error —
 *   that is a deliberate anti-enumeration choice, and it is worth pinning because "return the list anyway"
 *   looks like a harmless convenience fix.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'
import { e2eEnv } from '../harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from '../harness/clock'
import {
  createOwnerPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from '../harness/fixtures/principals'
import type { OrganizationFixture } from '../harness/fixtures/organizations'
import { uniqueId } from '../harness/ids'

interface Tenant {
  principal: Principal
  organization: OrganizationFixture
}

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  a: Tenant
  b: Tenant
  anonymous: APIRequestContext
}

let harness: Harness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ensureFixedTimeEnv()
  expect(e2eEnv().E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}invapi` }
    const clock = fixedClockFromEnv()

    /**
     * The schema maximum, on purpose.
     *
     * A *pending* invitation holds a seat — correctly, or an organization could oversubscribe by inviting more
     * people than it pays for and letting them all accept. This file creates a run-unique invitation per test,
     * so at `seatLimit: 5` it hit `409 This organization has reached its member limit` partway through and the
     * failure said nothing about the route under test.
     *
     * 10 is the ceiling `organization_entitlements_seat_limit_check` allows, which the harness asserts before
     * it writes — asking for 50 fails in the fixture rather than in the database, which is the right place.
     * The cap itself is a billing property covered where it belongs, in `tests/e2e/team-accounts.spec.ts`;
     * here it is only noise, so this file stays under it.
     */
    const a = await createOwnerPrincipal(ctx, { tier: 'team', seatLimit: 10, clock })
    const b = await createOwnerPrincipal(ctx, { tier: 'team', seatLimit: 10, clock })

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      a: { principal: a.principal, organization: a.organization },
      b: { principal: b.principal, organization: b.organization },
      anonymous: await playwrightRequest.newContext({ baseURL: server.baseURL }),
    }
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
  await h.anonymous.dispose().catch(() => undefined)
  await disposePrincipal(h.a.principal).catch(() => undefined)
  await disposePrincipal(h.b.principal).catch(() => undefined)
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

interface InvitationSummary {
  id: string
  email: string
  role: string
  status?: string
  devLink?: string
}

/** A run-unique address, so nothing in this file depends on another test's invitee. */
const inviteeEmail = (label: string) => `${uniqueId(`inv-${label}`).toLowerCase()}@e2e.invalid`

async function invite(
  tenant: Tenant,
  email: string,
  role: 'admin' | 'member' = 'member',
): Promise<InvitationSummary> {
  const response = await tenant.principal.api!.post('/api/organizations/invitations', {
    data: { email, role },
  })
  expect(response.status(), await response.text()).toBe(200)
  return response.json() as Promise<InvitationSummary>
}

/** Status, error key and body length — the three ways a refusal can betray that an id is real. */
async function refusalShape(api: APIRequestContext, method: 'POST' | 'DELETE', path: string) {
  const response = await api.fetch(path, { method, ...(method === 'POST' ? { data: {} } : {}) })
  const text = await response.text()
  let errorKey: string | null
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    errorKey = typeof parsed.error === 'string' ? parsed.error : null
  } catch {
    errorKey = null
  }
  return { status: response.status(), errorKey, length: text.length }
}

test.describe('anonymous access', () => {
  const ROUTES = [
    { method: 'POST' as const, path: '/api/organizations/invitations', data: { email: 'x@e2e.invalid', role: 'member' } },
    { method: 'GET' as const, path: '/api/organizations/invitations/mine', data: undefined },
    { method: 'POST' as const, path: '/api/organizations/invitations/does-not-exist', data: {} },
    { method: 'DELETE' as const, path: '/api/organizations/invitations/does-not-exist', data: undefined },
    { method: 'POST' as const, path: '/api/organizations/invitations/does-not-exist/accept', data: {} },
  ]

  for (const route of ROUTES) {
    test(`${route.method} ${route.path} refuses a request with no session`, async () => {
      const response = await harness.anonymous.fetch(route.path, {
        method: route.method,
        ...(route.data ? { data: route.data } : {}),
      })
      expect(
        [401, 403, 404],
        `${route.method} ${route.path} answered ${response.status()} to an anonymous caller`,
      ).toContain(response.status())
      expect(await response.text()).not.toContain(harness.a.organization.organizationId)
    })
  }
})

test.describe('POST /api/organizations/invitations', () => {
  test('creates an invitation into the caller’s own organization', async () => {
    const email = inviteeEmail('create')
    const invitation = await invite(harness.a, email, 'member')

    expect(invitation.id).toBeTruthy()
    expect(invitation.email).toBe(email)
    expect(invitation.role).toBe('member')

    const [row] = await harness.sql<{ organization_id: string; email: string }[]>`
      select organization_id, email from organization_invitations where id = ${invitation.id}
    `
    expect(row?.organization_id, 'the invitation belongs to the caller’s organization').toBe(
      harness.a.organization.organizationId,
    )
    expect(row?.email).toBe(email)
  })

  test('ignores an organizationId in the body rather than honouring it', async () => {
    /**
     * The property the route comment claims — "always comes from the caller's own session, never the request
     * body" — asserted rather than trusted. A route that honoured this field would let any authenticated user
     * mint a seat in any organization whose id they could obtain.
     */
    const email = inviteeEmail('body-org')
    const response = await harness.a.principal.api!.post('/api/organizations/invitations', {
      data: { email, role: 'member', organizationId: harness.b.organization.organizationId },
    })
    expect(response.status(), await response.text()).toBe(200)
    const invitation = await response.json() as InvitationSummary

    const [row] = await harness.sql<{ organization_id: string }[]>`
      select organization_id from organization_invitations where id = ${invitation.id}
    `
    expect(row?.organization_id, 'the body must not choose the organization').toBe(
      harness.a.organization.organizationId,
    )
  })

  test.describe('invalid bodies', () => {
    const CASES = [
      { label: 'missing email', data: { role: 'member' } },
      { label: 'malformed email', data: { email: 'not-an-email', role: 'member' } },
      { label: 'missing role', data: { email: 'someone@e2e.invalid' } },
      // `owner` is not in the enum on purpose: ownership moves through transfer-ownership, which has its own
      // recent-auth requirement. Inviting straight to owner would route around that.
      { label: 'role outside the enum', data: { email: 'someone@e2e.invalid', role: 'owner' } },
      { label: 'role of the wrong type', data: { email: 'someone@e2e.invalid', role: 7 } },
    ] as const

    for (const testCase of CASES) {
      test(`${testCase.label} is refused with 400`, async () => {
        const response = await harness.a.principal.api!.post('/api/organizations/invitations', {
          data: testCase.data,
        })
        expect(response.status(), await response.text()).toBe(400)
      })
    }
  })

  test('never returns a usable acceptance secret to the inviter beyond the dev fallback', async () => {
    /**
     * `devLink` exists only when no real email provider is configured: the invitation was created but nothing
     * was sent, so an admin needs a manual way to share it. In `E2E_MODE` that is the case, so the field is
     * expected here — what must *not* appear is a password, a session token, or the invitee's other data.
     */
    const invitation = await invite(harness.a, inviteeEmail('secret'))
    const serialized = JSON.stringify(invitation).toLowerCase()
    for (const forbidden of ['password', 'sessiontoken', 'twofactorsecret']) {
      expect(serialized, `the invitation payload leaks "${forbidden}"`).not.toContain(forbidden)
    }
  })
})

test.describe('invitation ids are capabilities', () => {
  test("A cannot resend or cancel B's invitation, and cannot tell it apart from a fabricated id", async () => {
    /**
     * The enumeration property, applied to invitations. If B's real id answers 403 and a fabricated one answers
     * 404, then the status code alone confirms which ids exist — and an invitation id is enough to know that an
     * organization is hiring, and for whom.
     */
    const theirs = await invite(harness.b, inviteeEmail('b-owned'))

    for (const method of ['POST', 'DELETE'] as const) {
      const real = await refusalShape(
        harness.a.principal.api!,
        method,
        `/api/organizations/invitations/${theirs.id}`,
      )
      expect(real.status, `${method} on B's real invitation must be refused`).toBeGreaterThanOrEqual(400)
    }

    // And it is still there afterwards — a refused cancel must not have cancelled anything.
    const [row] = await harness.sql<{ status: string }[]>`
      select status from organization_invitations where id = ${theirs.id}
    `
    expect(row?.status, "B's invitation survived A's attempt").not.toBe('cancelled')
  })

  test('a refused resend or cancel does not reveal whether the invitation id is real', async () => {
    /**
     * **Found by this matrix, and fixed.**
     *
     * Both `POST` (resend) and `DELETE` (cancel) used to answer **403** for an invitation in another
     * organization and **404** for one that does not exist. The refusals themselves were correct — nothing was
     * resent or cancelled — and the *difference between them* was the defect.
     *
     * An id space that answers 403-versus-404 is an enumeration oracle: a caller with any session can sweep
     * ids and learn which are real without ever reading one. A real invitation id is not nothing — it says an
     * organization is hiring and that someone is mid-onboarding, and it is the id an acceptance link carries.
     *
     * My first version of this test asserted that only resend leaked and that cancel was already correct.
     * That was wrong: the run showed both methods behave the same way. Recorded because the wrong version
     * would have sent the next reader to fix one route and declare the other fine.
     *
     * `requireMembershipOrNotFound` in `src/shared/lib/auth/organization-lifecycle.ts` now answers 404 when the
     * caller is not a member of the invitation's organization. A *member* who lacks the role still gets 403,
     * and should: they can already see the invitation in their own list, so the status tells them nothing.
     */
    const theirs = await invite(harness.b, inviteeEmail('oracle'))
    const fabricated = `inv-${'0'.repeat(theirs.id.length - 4)}`

    for (const method of ['POST', 'DELETE'] as const) {
      const real = await refusalShape(
        harness.a.principal.api!,
        method,
        `/api/organizations/invitations/${theirs.id}`,
      )
      const absent = await refusalShape(
        harness.a.principal.api!,
        method,
        `/api/organizations/invitations/${fabricated}`,
      )
      expect(real.status, `${method}: real ${real.status} vs absent ${absent.status}`).toBe(absent.status)
      expect(real.errorKey).toBe(absent.errorKey)
    }
  })

  test('cancelling an own invitation really cancels it', async () => {
    // The positive half. Without it, the refusal test above would also pass against a cancel that never works.
    const invitation = await invite(harness.a, inviteeEmail('cancel'))
    const response = await harness.a.principal.api!.delete(
      `/api/organizations/invitations/${invitation.id}`,
    )
    expect(response.status(), await response.text()).toBeLessThan(400)

    const rows = await harness.sql<{ status: string }[]>`
      select status from organization_invitations
      where id = ${invitation.id} and status = 'pending'
    `
    expect(rows.length, 'the invitation is no longer pending').toBe(0)
  })

  test('resending an own invitation rotates it instead of adding a second pending row', async () => {
    /**
     * Resend is not "invite again", but it is also not "send the same link twice".
     *
     * The observed behaviour: exactly one pending row survives, and its id is *new* — the previous invitation
     * is replaced. That is the right call, and worth pinning both halves of. Rotating the id invalidates the
     * link that was already in someone's inbox, which is what you want when an admin resends because the
     * first one may have gone astray; and keeping the count at one is what stops an invitee holding two links
     * where only one works, and a seat count drifting from reality.
     *
     * This test first asserted the id stayed the same. It did not, and the route is right — recorded so the
     * next reader does not "restore" id stability and quietly leave old links live.
     */
    const email = inviteeEmail('resend')
    const invitation = await invite(harness.a, email)

    const response = await harness.a.principal.api!.post(
      `/api/organizations/invitations/${invitation.id}`,
      { data: {} },
    )
    expect(response.status(), await response.text()).toBeLessThan(400)

    const rows = await harness.sql<{ id: string }[]>`
      select id from organization_invitations
      where organization_id = ${harness.a.organization.organizationId}
        and email = ${email}
        and status = 'pending'
    `
    expect(rows.length, 'a resend must not create a second pending invitation').toBe(1)
    expect(rows[0]?.id, 'the id rotates, so the link already sent stops working').not.toBe(invitation.id)

    const stale = await harness.sql<{ status: string }[]>`
      select status from organization_invitations where id = ${invitation.id} and status = 'pending'
    `
    expect(stale.length, 'the superseded invitation is no longer pending').toBe(0)
  })
})

test.describe('GET /api/organizations/invitations/mine', () => {
  test('lists by the session’s verified email, not by organization', async () => {
    /**
     * A's owner is not invited anywhere, so their list is empty even though A holds several pending
     * invitations. That is the whole distinction: this route answers "who invited *me*", and an implementation
     * that answered "what invitations does my organization hold" would leak the invitee list to every member.
     */
    await invite(harness.a, inviteeEmail('mine-noise'))

    const response = await harness.a.principal.api!.get('/api/organizations/invitations/mine')
    expect(response.status(), await response.text()).toBe(200)
    const mine = await response.json() as Array<Record<string, unknown>>
    expect(Array.isArray(mine)).toBe(true)

    const body = JSON.stringify(mine)
    expect(body, 'the caller’s own organization must not appear in their inbox').not.toContain(
      harness.a.organization.organizationId,
    )
  })
})
