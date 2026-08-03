import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { resolveEnforcementForUser } from '~/shared/lib/abuse/enforcement'
import { createStepupCookieValue, isStepupCookieValid, readCookie, stepupSetCookieHeader, STEPUP_COOKIE_NAME } from '~/shared/lib/auth/stepup'
import { rateLimit } from '~/shared/lib/rate-limit'

/**
 * Step-up re-authentication (abuse-and-usage-integrity plan, Phase 5's second task) — a password
 * challenge before the next sensitive action once a user's enforcement stage reaches `'stepup'`.
 *
 * GET: reports the caller's current enforcement stage and whether a still-valid step-up cookie is
 * already present, so the UI knows whether to show the password prompt at all.
 * POST: verifies the supplied password via better-auth's own `auth.api.verifyPassword` (confirmed
 * to already exist in better-auth core — no new dependency), and on success sets the signed,
 * time-boxed `bh_stepup` cookie (`auth/stepup.ts`) that `requireStepUp` (a reusable guard, not yet
 * wired into a specific "sensitive action" — this task's own doc doesn't name one) checks.
 * Rate-limited per-user to blunt password-guessing against this endpoint specifically.
 */
export const Route = createFileRoute('/api/me/stepup/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const authSession = await auth.api.getSession({ headers: request.headers })
          if (!authSession?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })

          const decision = await resolveEnforcementForUser(authSession.user.id)
          const cookieValue = readCookie(request.headers.get('cookie'), STEPUP_COOKIE_NAME)
          const steppedUp = isStepupCookieValid(cookieValue, authSession.user.id)

          return Response.json({ stage: decision.stage, requiresStepUp: decision.stage === 'stepup' && !steppedUp })
        } catch (err) {
          console.error('stepup status error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const authSession = await auth.api.getSession({ headers: request.headers })
          if (!authSession?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })

          const rl = await rateLimit('stepup-verify', authSession.user.id, 5, 300)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many attempts. Please wait before trying again.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const parsed = z.object({ password: z.string().min(1) }).safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }

          try {
            await auth.api.verifyPassword({ body: { password: parsed.data.password }, headers: request.headers })
          } catch {
            return Response.json({ error: 'Incorrect password' }, { status: 401 })
          }

          const cookieValue = createStepupCookieValue(authSession.user.id)
          return Response.json({ verified: true }, { headers: { 'Set-Cookie': stepupSetCookieHeader(cookieValue) } })
        } catch (err) {
          console.error('stepup verify error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
