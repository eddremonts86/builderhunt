/**
 * Wave 2 Task 7 — authentication, sessions, and invitation redirect
 * preservation (docs/superpowers/plans/2026-07-23-exhaustive-local-e2e.md).
 *
 * Runs against a per-worker disposable database + Redis namespace + app
 * server (the Wave 1 harness), never the shared dev database. Every browser
 * test runs under `expectStrictBrowser`; expected 4xx resource-load console
 * errors are opted out one occurrence at a time with a comment naming the
 * exact request that produces each one.
 *
 * Deliberately NOT duplicated here:
 *   - the direct sign-up API active-organization regression
 *     (e2e/signup-active-organization.spec.ts) — this file re-checks the
 *     same invariant through the real sign-up UI instead;
 *   - the signed-IN invitation accept path, role changes, seat races
 *     (e2e/team-accounts.spec.ts) — this file covers the signed-OUT
 *     invitation → sign-in → return leg that team-accounts explicitly
 *     left out, plus the unverified-user denial.
 *
 * Sign-up budget note: better-auth rate-limits `/sign-up/email` to 10/day
 * per IP (src/shared/lib/auth/better-auth.ts) and its counter lives in the
 * per-worker app server process. This file performs at most 7 sign-up
 * POSTs against its worker server (4 fixture principals in beforeAll, one
 * UI sign-up, one duplicate-email attempt, one weak-password attempt) —
 * comfortably inside the limit, but do not add sign-ups casually.
 */
import { test, expect, type Page } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

// Plain Node process — nothing auto-loads .env for the direct-DB admin
// connection used by the harness teardown.
loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import {
  credentialsFor,
  getSession,
  newApiContext,
  sessionFromStorageState,
  signIn,
} from './harness/auth'
import {
  dismissOverlays,
  expectStrictBrowser,
  gotoHydrated,
  twoContexts,
  waitForHydration,
  type StrictBrowserGuard,
} from './harness/browser'
import {
  allowlistEmailForSignup,
  createOwnerPrincipal,
  createUnverifiedPrincipal,
  createVerifiedPrincipal,
  disposePrincipal,
  type FixtureContext,
  type Principal,
} from './harness/fixtures/principals'
import type { OrganizationFixture } from './harness/fixtures/organizations'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  ctx: FixtureContext
  /** Verified user with a personal workspace — the invitee for the redirect-preservation flow. */
  verified: Principal
  /** Signed-up but never email-verified — invitation acceptance must deny them. */
  unverified: Principal
  /** Owner of the shared team organization that issues invitations. */
  owner: Principal
  /** Dedicated principal whose password gets rotated by the reset flow. */
  resetUser: Principal
  organization: OrganizationFixture
}

let harness: Harness

test.beforeAll(async () => {
  // Disposable DB creation + migrations + vite dev server boot.
  test.setTimeout(300_000)

  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}-auth` }
    const clock = fixedClockFromEnv()

    const verified = await createVerifiedPrincipal(ctx)
    const unverified = await createUnverifiedPrincipal(ctx)
    const { principal: owner, organization } = await createOwnerPrincipal(ctx, {
      tier: 'team',
      seatLimit: 5,
      clock,
    })
    const resetUser = await createVerifiedPrincipal(ctx, 'reset-user')

    // Accept the current ToS/privacy/cookie versions through the real
    // consent API for every fixture principal. Without this, any full
    // document load while signed in mounts the blocking ToS modal — and
    // after a CLIENT-side navigation (e.g. sign-in → dashboard) the modal
    // never mounts at all while `/api/consent` still reports tos pending,
    // which would make `dismissOverlays` wait forever for a modal that is
    // not coming. Consent is not what this spec is testing.
    for (const principal of [verified, unverified, owner, resetUser]) {
      for (const document of ['tos', 'privacy', 'cookies'] as const) {
        const res = await principal.api!.post('/api/consent', { data: { document, version: 'v1.0' } })
        if (!res.ok()) throw new Error(`consent seed failed for ${principal.email}: ${res.status()}`)
      }
    }

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      ctx,
      verified,
      unverified,
      owner,
      resetUser,
      organization,
    }
  } catch (error) {
    // Never leak the worker's server/database/redis when setup fails —
    // `harness` was never assigned, so afterAll would clean nothing.
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  const h = harness
  if (!h) return
  for (const principal of [h.verified, h.unverified, h.owner, h.resetUser]) {
    await disposePrincipal(principal).catch(() => undefined)
  }
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  // Terminate straggler backends from the app server's pools so DROP
  // DATABASE cannot fail with "being accessed by other users".
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

/** Absolute URL on THIS worker's app server (never the global config baseURL). */
function url(path: string): string {
  return new URL(path, harness.baseURL).toString()
}

/** The session as the page itself sees it — same endpoint the app's client uses. */
async function pageSession(page: Page): Promise<{ userId: string; email: string; activeOrganizationId: string | null } | null> {
  return page.evaluate(async () => {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' })
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as {
      user?: { id: string; email: string }
      session?: { activeOrganizationId?: string | null }
    } | null
    if (!body?.user) return null
    return {
      userId: body.user.id,
      email: body.user.email,
      activeOrganizationId: body.session?.activeOrganizationId ?? null,
    }
  })
}

/**
 * Every dashboard-layout document mount probes `GET /api/admin/incidents`
 * to decide whether to show admin links (DashboardLayout.tsx) — a 403 for
 * every non-platform-admin, which Chromium logs as a resource-load console
 * error. Register exactly one opt-out per expected dashboard mount.
 */
function allowIncidentsProbe(guard: StrictBrowserGuard, mounts = 1): void {
  for (let i = 0; i < mounts; i++) guard.allowExpectedFailure(/Failed to load resource/)
}

/**
 * DashboardPage settles three data fetches after mount and logs
 * "Dashboard load error" if one dies mid-flight — which is exactly what a
 * reload or sign-out issued while they are still pending looks like
 * (navigation aborts the fetch). `data-dashboard-state` flips to `ready` only
 * once loading finished, so waiting for it means no dashboard fetch is left to
 * abort. Call before triggering any further navigation from /dashboard.
 *
 * This waited on `#stats-heading` until 2026-07-27, when the bento rewrite
 * removed that heading and silently broke every test that lands on the
 * dashboard. Keyed to an explicit attribute now, not to incidental markup.
 */
async function waitForDashboardSettled(page: Page): Promise<void> {
  await page.locator('[data-dashboard-state="ready"]').waitFor({ state: 'attached' })
}

/** Accepts a Principal directly (whose fields are nullable) — authenticated fixtures always carry credentials. */
async function uiSignIn(page: Page, credentials: { email: string | null; password: string | null }): Promise<void> {
  expect(credentials.email).toBeTruthy()
  expect(credentials.password).toBeTruthy()
  await gotoHydrated(page, url('/auth/sign-in'))
  await page.locator('#email').fill(credentials.email!)
  await page.locator('#password').fill(credentials.password!)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

interface OutboxEmail {
  to: string
  subject: string
  html: string
  sentAt: string
}

async function readServerOutbox(): Promise<OutboxEmail[]> {
  const res = await fetch(url('/api/e2e/outbox'))
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { emails: OutboxEmail[] }
  return body.emails
}

async function clearServerOutbox(): Promise<void> {
  const res = await fetch(url('/api/e2e/outbox'), { method: 'DELETE' })
  expect(res.ok).toBe(true)
}

/** Extract the reset link better-auth put into the captured reset email. */
function resetLinkFrom(email: OutboxEmail): string {
  const match = email.html.match(/href="([^"]+)"/)
  expect(match, 'reset email carries a link').toBeTruthy()
  return match![1]
}

async function requestPasswordReset(email: string): Promise<string> {
  await clearServerOutbox()
  const api = await newApiContext(harness.baseURL)
  try {
    const res = await api.post('/api/auth/request-password-reset', {
      data: { email, redirectTo: '/auth/reset' },
    })
    expect(res.ok()).toBe(true)
  } finally {
    await api.dispose()
  }
  const emails = await readServerOutbox()
  const entry = emails.find((e) => e.to === email && e.subject === 'Reset your BuilderHunt password')
  expect(entry, `outbox holds a reset email for ${email}`).toBeTruthy()
  return resetLinkFrom(entry!)
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

test('sign-up through the real UI creates a session already scoped to the personal workspace', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  const credentials = credentialsFor('ui-signup', harness.ctx.scope)
  // Invite-only sign-up: pre-approve so the real gate admits this UI sign-up. See `allowlistEmailForSignup`.
  await allowlistEmailForSignup(harness.sql, credentials.email)

  await gotoHydrated(page, url('/auth/sign-up'))
  await page.locator('#name').fill(credentials.name)
  await page.locator('#email').fill(credentials.email)
  await page.locator('#password').fill(credentials.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/onboarding\/welcome/)

  // First-active-organization regression, at the UI level: the very first
  // session — no reload, no manual organization pick — must already be
  // scoped to the personal workspace membership created by sign-up.
  const session = await pageSession(page)
  expect(session).toBeTruthy()
  expect(session!.email).toBe(credentials.email)
  expect(session!.activeOrganizationId).not.toBeNull()
  const memberships = await harness.sql<{ organization_id: string }[]>`
    select organization_id from organization_members
    where user_id = ${session!.userId}
  `
  expect(memberships).toHaveLength(1)
  expect(memberships[0].organization_id).toBe(session!.activeOrganizationId)

  guard.assertClean()
  guard.dispose()
})

test('sign-up validation gates submission until the password policy is satisfied', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  await gotoHydrated(page, url('/auth/sign-up'))

  const submit = page.getByRole('button', { name: 'Create account' })
  // Empty form: the password gate alone keeps the button disabled.
  await expect(submit).toBeDisabled()

  // Weak password: checklist renders (from React state) and submit stays gated.
  await page.locator('#email').fill(credentialsFor('never-created', harness.ctx.scope).email)
  await page.locator('#password').fill('short1')
  await expect(page.getByText('At least 8 characters')).toBeVisible()
  await expect(page.getByText('Letters and numbers')).toBeVisible()
  await expect(submit).toBeDisabled()

  // Policy satisfied: gate opens. (No submission — this test creates no user.)
  await page.locator('#password').fill('long-enough-passw0rd')
  await expect(submit).toBeEnabled()

  guard.assertClean()
  guard.dispose()
})

test('the server rejects a weak password even when the client gate is bypassed', async () => {
  const credentials = credentialsFor('weak-password', harness.ctx.scope)
  const api = await newApiContext(harness.baseURL)
  try {
    const res = await api.post('/api/auth/sign-up/email', {
      data: { name: credentials.name, email: credentials.email, password: 'short1' },
    })
    expect(res.status()).toBe(400)
  } finally {
    await api.dispose()
  }
  const rows = await harness.sql<{ id: string }[]>`
    select id from auth_users where email = ${credentials.email}
  `
  expect(rows).toHaveLength(0)
})

test('signing up with an already-registered email surfaces the server error in the form', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  // One expected 4xx: POST /api/auth/sign-up/email rejects the duplicate.
  guard.allowExpectedFailure(/Failed to load resource/)

  await gotoHydrated(page, url('/auth/sign-up'))
  await page.locator('#email').fill(harness.verified.email!)
  await page.locator('#password').fill(harness.verified.password!)
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page.getByRole('alert')).toBeVisible()
  expect(page.url()).toContain('/auth/sign-up')
  // Still signed out — the failed attempt minted no session.
  expect(await pageSession(page)).toBeNull()

  guard.assertClean()
  guard.dispose()
})

// ---------------------------------------------------------------------------
// Sign-in, sign-out, session persistence
// ---------------------------------------------------------------------------

test('sign-in via the UI lands on the dashboard and the session survives a reload', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  // Two dashboard document mounts (initial navigation + reload) — see allowIncidentsProbe.
  allowIncidentsProbe(guard, 2)

  await uiSignIn(page, harness.verified)
  await page.waitForURL(/\/dashboard/)
  await dismissOverlays(page)
  const before = await pageSession(page)
  expect(before?.userId).toBe(harness.verified.userId)

  // Never reload with dashboard fetches still in flight — the abort would
  // surface as an app console.error and trip the strict guard.
  await waitForDashboardSettled(page)
  await page.reload()
  await waitForHydration(page)
  await dismissOverlays(page)
  expect(page.url()).toContain('/dashboard')
  const after = await pageSession(page)
  expect(after?.userId).toBe(harness.verified.userId)

  guard.assertClean()
  guard.dispose()
})

test('wrong credentials are rejected with an inline error and no session', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  // One expected 4xx: POST /api/auth/sign-in/email rejects the bad password.
  guard.allowExpectedFailure(/Failed to load resource/)

  await uiSignIn(page, { email: harness.verified.email!, password: 'definitely-not-the-passw0rd' })
  await expect(page.getByRole('alert')).toBeVisible()
  expect(page.url()).toContain('/auth/sign-in')
  expect(await pageSession(page)).toBeNull()

  guard.assertClean()
  guard.dispose()
})

test('sign-out ends the session for that browser context only — cookie jars never leak', async ({ browser }) => {
  const { pageA, pageB, close } = await twoContexts(browser)
  const guardA = expectStrictBrowser(pageA)
  const guardB = expectStrictBrowser(pageB)
  // One dashboard mount per context after sign-in, plus one for B's reload.
  allowIncidentsProbe(guardA, 1)
  allowIncidentsProbe(guardB, 2)

  try {
    await uiSignIn(pageA, harness.owner)
    await pageA.waitForURL(/\/dashboard/)
    await dismissOverlays(pageA)
    await uiSignIn(pageB, harness.verified)
    await pageB.waitForURL(/\/dashboard/)
    await dismissOverlays(pageB)

    // Isolated cookie jars: each context authenticates as its own user.
    const sessionA = await pageSession(pageA)
    const sessionB = await pageSession(pageB)
    expect(sessionA?.email).toBe(harness.owner.email)
    expect(sessionB?.email).toBe(harness.verified.email)

    // Sign out A through the real menu — after A's dashboard fetches
    // settled, so the sign-out cannot abort one mid-flight.
    await waitForDashboardSettled(pageA)
    await pageA.getByRole('button', { name: 'Account menu' }).click()
    await pageA.getByRole('menuitem', { name: 'Sign out' }).click()
    await pageA.waitForURL(/\/auth\/sign-in/)
    expect(await pageSession(pageA)).toBeNull()

    // B's session is untouched — including across a full document reload.
    await waitForDashboardSettled(pageB)
    await pageB.reload()
    await waitForHydration(pageB)
    await dismissOverlays(pageB)
    expect(pageB.url()).toContain('/dashboard')
    expect((await pageSession(pageB))?.email).toBe(harness.verified.email)

    guardA.assertClean()
    guardB.assertClean()
  } finally {
    guardA.dispose()
    guardB.dispose()
    await close()
  }
})

test('an expired session no longer authenticates and protected routes bounce to sign-in', async ({ browser }) => {
  // Mint a REAL session for the verified user (a second one — the fixture's
  // own live context stays untouched), then expire exactly that session row.
  const api = await newApiContext(harness.baseURL)
  let storageState: Awaited<ReturnType<typeof api.storageState>>
  try {
    await signIn(api, { email: harness.verified.email!, password: harness.verified.password! })
    storageState = await api.storageState()
  } finally {
    await api.dispose()
  }
  const sessionCookie = storageState.cookies.find((c) => c.name.includes('session_token'))
  expect(sessionCookie, 'sign-in set a session cookie').toBeTruthy()
  // Cookie value is `${token}.${signature}` — auth_sessions.token stores the token part.
  const token = decodeURIComponent(sessionCookie!.value).split('.')[0]
  const updated = await harness.sql<{ id: string }[]>`
    update auth_sessions set expires_at = now() - interval '1 day'
    where token = ${token} returning id
  `
  expect(updated).toHaveLength(1)

  // The expired state no longer authenticates at the API...
  expect(await sessionFromStorageState(harness.baseURL, storageState)).toBeNull()

  // ...and a browser carrying it is bounced off protected routes.
  const context = await browser.newContext({ storageState })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  try {
    await page.goto(url('/dashboard'))
    await page.waitForURL(/\/auth\/sign-in/)
    await waitForHydration(page)
    expect(await pageSession(page)).toBeNull()
    guard.assertClean()
  } finally {
    guard.dispose()
    await context.close()
  }

  // The fixture's own session survives — only the targeted row expired.
  expect((await getSession(harness.verified.api!))?.userId).toBe(harness.verified.userId)
})

// ---------------------------------------------------------------------------
// Redirect handling on sign-in
// ---------------------------------------------------------------------------

test('sign-in preserves a same-origin deep link through ?redirect=', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  // One dashboard-layout mount at /settings/team.
  allowIncidentsProbe(guard, 1)

  await gotoHydrated(page, url('/auth/sign-in?redirect=/settings/team'))
  await page.locator('#email').fill(harness.owner.email!)
  await page.locator('#password').fill(harness.owner.password!)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/settings\/team/)
  await dismissOverlays(page)

  guard.assertClean()
  guard.dispose()
})

test('sign-in rejects open redirects and falls back to the dashboard', async ({ browser }) => {
  // `//host` (protocol-relative) and absolute-URL redirects must both be
  // discarded. The strict guard doubles as the security assertion: any
  // attempt to actually navigate off-origin would be recorded as egress.
  for (const attack of ['//evil.example.com', 'https://evil.example.com/phish']) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const guard = expectStrictBrowser(page)
    allowIncidentsProbe(guard, 1) // one dashboard mount per attempt
    try {
      await gotoHydrated(page, url(`/auth/sign-in?redirect=${encodeURIComponent(attack)}`))
      await page.locator('#email').fill(harness.verified.email!)
      await page.locator('#password').fill(harness.verified.password!)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL(/\/dashboard/)
      await dismissOverlays(page)
      expect(new URL(page.url()).origin).toBe(new URL(harness.baseURL).origin)
      guard.assertClean()
    } finally {
      guard.dispose()
      await context.close()
    }
  }
})

test('a signed-out dashboard deep link round-trips through sign-in back to the original page', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  // One dashboard-layout mount at /settings/team after the sign-in returns.
  allowIncidentsProbe(guard, 1)

  // Signed out → the _dashboard guard bounces to sign-in carrying the FULL
  // original location (path + search) as ?redirect=, not a bare /auth/sign-in.
  const deepLink = '/settings/team?from=e2e-deep-link'
  await page.goto(url(deepLink))
  await page.waitForURL(/\/auth\/sign-in/)
  await waitForHydration(page)
  expect(new URL(page.url()).searchParams.get('redirect')).toBe(deepLink)

  await page.locator('#email').fill(harness.owner.email!)
  await page.locator('#password').fill(harness.owner.password!)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Sign-in returns to the original deep link — query string included.
  await page.waitForURL(/\/settings\/team/)
  await dismissOverlays(page)
  const landed = new URL(page.url())
  expect(landed.pathname).toBe('/settings/team')
  expect(landed.searchParams.get('from')).toBe('e2e-deep-link')

  guard.assertClean()
  guard.dispose()
})

// ---------------------------------------------------------------------------
// Forgot / reset password (through the E2E outbox)
// ---------------------------------------------------------------------------

test('forgot password delivers a reset email, the link rotates the credential, and the token is single-use', async ({ page }) => {
  test.setTimeout(60_000)
  const guard = expectStrictBrowser(page)
  const { resetUser } = harness
  const newPassword = 'rotated-E2e-passw0rd!'

  await clearServerOutbox()
  await gotoHydrated(page, url('/auth/forgot'))
  await page.locator('#email').fill(resetUser.email!)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toBeVisible()

  // The app server recorded the email in its in-process outbox.
  const emails = await readServerOutbox()
  const entry = emails.find((e) => e.to === resetUser.email && e.subject === 'Reset your BuilderHunt password')
  expect(entry, 'reset email captured in outbox').toBeTruthy()
  const link = resetLinkFrom(entry!)
  expect(link).toContain('/api/auth/reset-password/')
  const token = new URL(link).pathname.split('/').pop()!

  // The emailed link redirects to the reset form with the token attached.
  await page.goto(link)
  await page.waitForURL(/\/auth\/reset\?token=/)
  await waitForHydration(page)
  await page.locator('#password').fill(newPassword)
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByRole('status')).toContainText('Password updated')
  await page.waitForURL(/\/auth\/sign-in/, { timeout: 10_000 })

  // Old password is dead, new password signs in.
  const api = await newApiContext(harness.baseURL)
  try {
    const stale = await api.post('/api/auth/sign-in/email', {
      data: { email: resetUser.email, password: resetUser.password },
    })
    expect(stale.status()).toBe(401)

    // Reused token: better-auth consumes the verification row on success,
    // so replaying the same token must fail.
    const replay = await api.post('/api/auth/reset-password', {
      data: { newPassword: 'another-E2e-passw0rd!', token },
    })
    expect(replay.status()).toBe(400)
  } finally {
    await api.dispose()
  }

  // One dashboard mount from the post-reset sign-in — registered BEFORE the
  // click: the guard consumes opt-outs at violation arrival time.
  allowIncidentsProbe(guard, 1)
  await page.locator('#email').fill(resetUser.email!)
  await page.locator('#password').fill(newPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
  await dismissOverlays(page)

  // Keep the fixture usable for any later test.
  resetUser.password = newPassword

  guard.assertClean()
  guard.dispose()
})

test('an invalid reset token is rejected, and a token-less link cannot submit at all', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  // One expected 4xx: POST /api/auth/reset-password rejects the bogus token.
  guard.allowExpectedFailure(/Failed to load resource/)

  await gotoHydrated(page, url('/auth/reset?token=e2e-bogus-token'))
  await page.locator('#password').fill('would-be-passw0rd!')
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByRole('alert')).toBeVisible()

  // No token at all: the form is disarmed before any request can be made.
  await gotoHydrated(page, url('/auth/reset'))
  await expect(page.getByRole('alert')).toContainText('missing its token')
  await expect(page.getByRole('button', { name: 'Update password' })).toBeDisabled()

  guard.assertClean()
  guard.dispose()
})

test('an expired reset token is rejected by both the emailed link and the API', async ({ page }) => {
  const guard = expectStrictBrowser(page)
  const { resetUser } = harness

  const link = await requestPasswordReset(resetUser.email!)
  const token = new URL(link).pathname.split('/').pop()!

  // Expire the verification row (better-auth stores the reset row with the
  // user id as its value; no product flow can move the clock, so this is
  // the deliberate direct-DB time-travel write).
  const expired = await harness.sql<{ id: string }[]>`
    update auth_verifications set expires_at = now() - interval '1 hour'
    where value = ${resetUser.userId!} returning id
  `
  expect(expired.length).toBeGreaterThan(0)

  // The emailed link now bounces to the reset page WITHOUT a token.
  await page.goto(link)
  await page.waitForURL(/\/auth\/reset/)
  await waitForHydration(page)
  expect(page.url()).not.toContain('token=' + token)
  await expect(page.getByRole('alert')).toContainText('missing its token')

  // And the raw API refuses the expired token outright.
  const api = await newApiContext(harness.baseURL)
  try {
    const res = await api.post('/api/auth/reset-password', {
      data: { newPassword: 'expired-E2e-passw0rd!', token },
    })
    expect(res.status()).toBe(400)
  } finally {
    await api.dispose()
  }

  guard.assertClean()
  guard.dispose()
})

// ---------------------------------------------------------------------------
// Invitations: unverified restriction + signed-out redirect preservation
// ---------------------------------------------------------------------------

async function createInvitation(email: string): Promise<string> {
  const response = await harness.owner.api!.post('/api/organizations/invitations', {
    data: { email, role: 'member' },
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { id: string }
  expect(body.id).toBeTruthy()
  return body.id
}

test('an unverified user cannot accept an invitation', async ({ browser }) => {
  const invitationId = await createInvitation(harness.unverified.email!)

  const context = await browser.newContext({ storageState: harness.unverified.storageState! })
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  // One expected 4xx: POST .../accept is denied (403, generic message).
  guard.allowExpectedFailure(/Failed to load resource/)
  try {
    await gotoHydrated(page, url(`/team/invite/${invitationId}`))
    await dismissOverlays(page)
    await expect(page.getByTestId('invitation-page')).toBeVisible()
    await page.getByTestId('invitation-accept-btn').click()
    await expect(page.getByTestId('invitation-error')).toContainText('no longer valid')

    // Denied means denied: no membership row appeared.
    const rows = await harness.sql<{ id: string }[]>`
      select id from organization_members
      where organization_id = ${harness.organization.organizationId}
        and user_id = ${harness.unverified.userId!}
    `
    expect(rows).toHaveLength(0)
    guard.assertClean()
  } finally {
    guard.dispose()
    await context.close()
  }
})

test('a signed-out invitation link round-trips through sign-in back to the original invitation', async ({ browser }) => {
  test.setTimeout(60_000)
  const invitationId = await createInvitation(harness.verified.email!)

  // Fresh context: signed out, exactly like a real invitee clicking the email link.
  const context = await browser.newContext()
  const page = await context.newPage()
  const guard = expectStrictBrowser(page)
  // One dashboard mount after the accepted invitation redirects there.
  allowIncidentsProbe(guard, 1)
  try {
    await gotoHydrated(page, url(`/team/invite/${invitationId}`))

    // Signed out → bounced to sign-in carrying the invitation as ?redirect=.
    await page.waitForURL(/\/auth\/sign-in/)
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toBe(`/team/invite/${invitationId}`)

    await page.locator('#email').fill(harness.verified.email!)
    await page.locator('#password').fill(harness.verified.password!)
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Sign-in returns to the ORIGINAL invitation URL — the ?redirect=
    // contract holds end to end.
    await page.waitForURL(new RegExp(`/team/invite/${invitationId}`))

    // The invitation page must render for the freshly signed-in invitee
    // WITHOUT a recovery reload: better-auth's client atom briefly reports
    // a stale signed-out value right after the client-side return, and the
    // page's guard is required to confirm against the server before
    // deciding to bounce (regression: stale-useSession redirect bug).
    expect((await pageSession(page))?.email).toBe(harness.verified.email)
    await dismissOverlays(page)
    await expect(page.getByTestId('invitation-page')).toBeVisible()
    await page.getByTestId('invitation-accept-btn').click()
    await page.waitForURL(/\/dashboard/)
    await dismissOverlays(page)

    const rows = await harness.sql<{ role: string }[]>`
      select role from organization_members
      where organization_id = ${harness.organization.organizationId}
        and user_id = ${harness.verified.userId!}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('member')
    guard.assertClean()
  } finally {
    guard.dispose()
    await context.close()
  }
})

