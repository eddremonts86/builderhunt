/**
 * A minted cookie has to be one better-auth accepts (plan: phase-1/55, phase 2).
 *
 * The unit test proves the rows land and the cookies are distinct. It cannot prove the only thing that
 * actually matters — that the server verifies one — because that needs the real app with the real secret.
 *
 * Without this spec the harness would be plausible and unproven, and the failure mode is quiet: every one
 * of four hundred thousand requests answers as an anonymous visitor, the run completes, and the report
 * describes the latency of the signed-out application. Fast numbers, wrong question.
 */
import { expect, test } from 'playwright/test'

import { mintSessions, resolveSessionCookieFormat } from '../../scripts/load/auth'
import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from './harness/fixtures/interviews'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'loadmint' })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

/**
 * The whole chain: learn the format from a real sign-in, mint against the database, replay the minted
 * cookie, and check the server answers as that person in that organization.
 */
test('the server accepts a minted cookie and scopes it to the right organization', async ({ request }) => {
  const owner = harness.owner
  const format = await resolveSessionCookieFormat({
    baseUrl: harness.baseURL,
    email: owner.email!,
    password: owner.password!,
    timeoutMs: 15_000,
    secret: process.env.BETTER_AUTH_SECRET,
  })

  const [session] = await mintSessions({
    sql: harness.sql,
    users: [{ email: owner.email!, organizationId: owner.organizationId!, sprintId: 'unused' }],
    format,
  })
  expect(session).toBeTruthy()

  // `/api/auth/get-session` is better-auth's own verification path — if it answers with this user, the
  // signature, the row and the cookie name are all correct together.
  const response = await request.get(`${harness.baseURL}/api/auth/get-session`, {
    headers: { cookie: session!.cookie },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { user?: { email?: string }; session?: { activeOrganizationId?: string } }
  expect(body.user?.email).toBe(owner.email)
  expect(body.session?.activeOrganizationId).toBe(owner.organizationId)
})

/**
 * A cookie signed with the wrong secret must be refused, or the check above proves nothing: an endpoint
 * that answered 200 for anything would satisfy it just as well.
 */
test('a cookie signed with the wrong secret is not a session', async ({ request }) => {
  const owner = harness.owner
  const [session] = await mintSessions({
    sql: harness.sql,
    users: [{ email: owner.email!, organizationId: owner.organizationId!, sprintId: 'unused' }],
    format: { name: 'better-auth.session_token', secret: 'a-secret-the-server-does-not-have' },
  })

  const response = await request.get(`${harness.baseURL}/api/auth/get-session`, {
    headers: { cookie: session!.cookie },
  })
  const body = (await response.json().catch(() => null)) as { user?: unknown } | null
  expect(body?.user ?? null).toBeNull()
})
