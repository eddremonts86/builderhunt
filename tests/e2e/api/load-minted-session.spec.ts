/**
 * The end-to-end claim `mintSessions` rests on: a session this harness writes and signs itself is one
 * the running application accepts.
 *
 * Everything else about minting is checked in `tests/unit/scripts/load/mint-sessions.test.ts` against a
 * disposable database — the batched insert, the refusals, the row shape. What a unit test cannot prove
 * is the only thing that actually matters: that `better-auth` verifies the cookie. If it does not, a
 * two-hour certification authenticates as nobody, every route answers 401, and the report reads as an
 * authorization defect in the product rather than as a broken harness.
 *
 * The cookie is built here by the exported `signSessionCookie`, not by a copy of its logic, so a change
 * to the format breaks this test rather than silently agreeing with itself.
 */
import { expect, request as playwrightRequest, test, type APIRequestContext } from 'playwright/test'
import { makeSignature } from 'better-auth/crypto'

import { signSessionCookie } from '../../../scripts/load/auth'
import { startInterviewHarness, stopInterviewHarness, type InterviewHarness } from '../harness/fixtures/interviews'

/** The busiest route in `LOAD_ROUTES` — the one a failure here would corrupt most of a run. */
const AUTHENTICATED_ROUTE = '/api/dashboard/overview'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'mint' })
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

test('a minted session cookie authenticates against the app the load run measures', async () => {
  const secret = process.env.BETTER_AUTH_SECRET
  expect(secret, 'BETTER_AUTH_SECRET must be set for the harness and the server to agree').toBeTruthy()

  const { userId, organizationId } = harness.owner
  expect(userId).toBeTruthy()

  const token = `e2e-minted-${testTokenSuffix()}`
  await harness.sql`
    insert into auth_sessions (id, user_id, token, expires_at, active_organization_id)
    values (${`ld_e2e_ses_${token}`}, ${userId}, ${token}, ${new Date(Date.now() + 3_600_000)}, ${organizationId})
  `

  const cookie = await signSessionCookie('better-auth.session_token', token, secret!)

  let anonymous: APIRequestContext | undefined
  try {
    anonymous = await playwrightRequest.newContext({ baseURL: harness.baseURL })

    // Without the cookie the same request must be refused, or a 200 below would prove nothing about
    // the cookie — the route could simply be public.
    const unauthenticated = await anonymous.get(AUTHENTICATED_ROUTE)
    expect(unauthenticated.status(), 'the route is not public').not.toBe(200)

    const authenticated = await anonymous.get(AUTHENTICATED_ROUTE, { headers: { cookie } })
    expect(authenticated.status()).toBe(200)
  } finally {
    await anonymous?.dispose()
  }
})

test('a cookie signed with the wrong secret is refused, so the guard is not theatre', async () => {
  const token = `e2e-wrong-${testTokenSuffix()}`
  await harness.sql`
    insert into auth_sessions (id, user_id, token, expires_at, active_organization_id)
    values (${`ld_e2e_ses_${token}`}, ${harness.owner.userId}, ${token}, ${new Date(Date.now() + 3_600_000)}, ${harness.owner.organizationId})
  `

  // The row exists and the token is real; only the signature is wrong. This is exactly the state
  // `mintSessions` refuses to create, and this asserts the application would reject it if it did.
  const cookie = await signSessionCookie('better-auth.session_token', token, 'a-different-secret-entirely')

  let anonymous: APIRequestContext | undefined
  try {
    anonymous = await playwrightRequest.newContext({ baseURL: harness.baseURL })
    const response = await anonymous.get(AUTHENTICATED_ROUTE, { headers: { cookie } })
    expect(response.status()).not.toBe(200)
  } finally {
    await anonymous?.dispose()
  }
})

test('the signature this harness produces is the one better-auth produces', async () => {
  // Cheap, and it is the invariant `probeSessionCookie` re-checks at the start of every real run.
  const secret = process.env.BETTER_AUTH_SECRET!
  const cookie = await signSessionCookie('n', 'tok', secret)
  const value = decodeURIComponent(cookie.slice('n='.length))
  expect(value).toBe(`tok.${await makeSignature('tok', secret)}`)
})

/** Unique per test, so two tests in one file cannot collide on `auth_sessions.token`'s unique index. */
function testTokenSuffix(): string {
  return `${process.pid}-${counter++}`
}
let counter = 0
