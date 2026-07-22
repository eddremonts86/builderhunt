import { test, expect } from 'playwright/test'
import postgres from 'postgres'
import { config as loadEnv } from 'dotenv'

// Same rationale as team-accounts.spec.ts: this file runs as a plain Node
// process, not through vite/vitest, so nothing auto-loads `.env` here.
loadEnv({ path: '.env' })

function uniqueEmail(label: string): string {
  return `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`
}

const PASSWORD = 'e2e-Test-Passw0rd!'

/**
 * Regression test for a real bug found while writing team-accounts.spec.ts
 * (confirmed directly via psql, not a test artifact): better-auth's
 * `/sign-up/email` endpoint wraps BOTH user creation and session creation in
 * one `runWithTransaction` call (node_modules/better-auth/dist/api/routes/
 * sign-up.mjs). Inside `with-hooks.mjs`, `user.create.after` hooks are
 * queued via `queueAfterTransactionHook`
 * (node_modules/@better-auth/core/dist/context/transaction.mjs), which only
 * flushes those hooks after the whole wrapped function resolves — i.e. after
 * the session has already been created. So `ensurePersonalOrganization`
 * (fired from `user.create.after`) was still pending when
 * `session.create.before` (better-auth.ts) ran `pickDefaultActiveOrganizationId`
 * for the brand-new session: every fresh sign-up landed with
 * `auth_sessions.active_organization_id = null` until the user manually
 * picked their own personal workspace from the organization switcher.
 *
 * Hits the sign-up endpoint directly (no UI, no reload, no manual org pick)
 * and asserts the very first session row already has a non-null
 * `active_organization_id` pointing at the user's personal workspace.
 *
 * Currently failing against real Postgres/better-auth — confirmed via this
 * exact test. Fixing the hook-ordering race is out of scope for the
 * team-accounts plan (auth infrastructure, not team-account behavior) and is
 * tracked as a standalone follow-up. Marked fixme so it documents the bug
 * without failing CI; flip to `test(...)` once the race is fixed.
 */
test.fixme('a fresh sign-up session has a non-null active organization immediately', async ({ request }) => {
  const email = uniqueEmail('signup-active-org')
  const response = await request.post('/api/auth/sign-up/email', {
    data: { email, name: 'Active Org Test', password: PASSWORD },
  })
  expect(response.ok()).toBe(true)

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    const [session] = await sql`
      select s.active_organization_id as "activeOrganizationId"
      from auth_sessions s
      join auth_users u on u.id = s.user_id
      where u.email = ${email}
      order by s.created_at asc
      limit 1
    `
    expect(session).toBeTruthy()
    expect(session.activeOrganizationId).not.toBeNull()

    const [membership] = await sql`
      select organization_id as "organizationId"
      from organization_members
      where user_id = (select id from auth_users where email = ${email})
    `
    expect(membership?.organizationId).toBe(session.activeOrganizationId)
  } finally {
    await sql.end()
  }
})
