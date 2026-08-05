import { APIError, betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { and, eq, gt } from 'drizzle-orm'
import { authDb } from '~/shared/lib/db/auth-db'
import {
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  organizations,
  organizationMembers,
  organizationInvitations,
} from '~/shared/lib/db/schema'
import { sendOrganizationInvitationEmail, sendResetPasswordEmail } from '~/shared/lib/email'
import { env } from '~/shared/lib/env'
import { handleSessionAfter, handleSessionBefore, type SessionCookieAdapter, type SessionDeviceResult } from '~/shared/lib/abuse/session-hooks'
import { resolveSessionTimeoutConfig } from '~/shared/lib/abuse/session-guard'
import { AccessNotAllowlistedError, checkSignupEmailGate, DisposableEmailRejectedError } from '~/shared/lib/abuse/email-hygiene'
import { isEmailAllowed } from '~/shared/lib/access-requests'
import { computeDeviceHash, detectUaFamily, DEVICE_COOKIE_NAME, issueDeviceCookieValue } from '~/shared/lib/abuse/device'
import { rateLimit } from '~/shared/lib/rate-limit'
import { organizationOptions } from './organization-options'
import { ensurePersonalOrganization, pickDefaultActiveOrganizationId } from './personal-organization'

function cookieAdapterFor(context: { getCookie?: (name: string) => string | null; setCookie?: (name: string, value: string, options?: Record<string, unknown>) => unknown } | null | undefined): SessionCookieAdapter {
  return {
    get: (name) => context?.getCookie?.(name) ?? null,
    set: (name, value, options) => {
      context?.setCookie?.(name, value, options)
    },
  }
}

// `session.create.before` resolves the device (needs cookie access, which
// only works reliably from `before` — see `session-hooks.ts`'s comment on
// `handleSessionBefore`) before the session row exists; `after` needs that
// same result once `session.id` exists to write `session_signals`. `context`
// is the same object instance for both hooks within one request (better-auth
// stores it via AsyncLocalStorage per-request), so it doubles as the
// correlation key — a WeakMap so entries are garbage-collected with the
// request context object, never a growing global.
const pendingSessionDevices = new WeakMap<object, SessionDeviceResult>()

// A brand-new sign-up runs `user.create.before` (device-hash rate limit) BEFORE
// `session.create.before` (device recognition/upsert) within the same request — but
// `context.getCookie` only ever reads the ORIGINAL incoming request's Cookie header, never a
// value set earlier in the same request by `context.setCookie`. Without this, both hooks would
// independently issue a fresh `bh_did` value on a brand-new signup, and the response would carry
// two conflicting `Set-Cookie: bh_did=...` headers (the browser silently keeps only the last one)
// — the two hooks would disagree about the device's identity for this one request. Recording the
// value here (keyed by the same per-request `context` object as `pendingSessionDevices`) lets
// `session.create.before` reuse exactly what `user.create.before` already issued.
const pendingSignupDeviceCookie = new WeakMap<object, string>()

export const auth = betterAuth({
  database: drizzleAdapter(authDb, {
    provider: 'pg',
    schema: {
      user: authUsers,
      session: authSessions,
      account: authAccounts,
      verification: authVerifications,
      organization: organizations,
      member: organizationMembers,
      invitation: organizationInvitations,
    },
  }),
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail(user.email, url)
    },
  },
  // abuse-and-usage-integrity plan, Phase 1 "Idle + absolute session timeouts".
  // better-auth's own model: `expiresIn` is the max lifetime a session can go
  // without being refreshed before it dies outright; `updateAge` is how much
  // of that window must remain before an active request bumps `expiresAt`
  // forward by `expiresIn` again. Mapped so `SESSION_IDLE_TIMEOUT_MINUTES`
  // (default 7 days) drives `updateAge` — matching better-auth's own 7-day
  // default when the env var is left at its default — and
  // `SESSION_ABSOLUTE_TIMEOUT_HOURS` (default 30 days) drives `expiresIn`,
  // the outer bound. This is a sliding window, not a hard "even a daily user
  // gets logged out on day 30" cap — a continuously active session keeps
  // refreshing indefinitely, same as any `expiresIn`/`updateAge` session
  // config. Both env vars are validated numbers with safe defaults
  // (`env.ts`), so this is always well-defined.
  session: resolveSessionTimeoutConfig(env.SESSION_ABSOLUTE_TIMEOUT_HOURS, env.SESSION_IDLE_TIMEOUT_MINUTES),
  databaseHooks: {
    user: {
      create: {
        // `before` is the only user.create hook stage that can abort creation: throwing here
        // propagates through better-auth's un-caught hook loop (dist/db/with-hooks.mjs) into the
        // sign-up route's try/catch (dist/api/routes/sign-up.mjs), which recognizes `APIError` and
        // rethrows it verbatim to the client — the transaction never commits, so no user row is
        // created. Same "before can block, after cannot" split as `session.create` (see the
        // cookie-write comment above `pendingSessionDevices`).
        before: async (user, context) => {
          // Invite gate (waitlist-launch plan). Read here rather than inside `checkSignupEmailGate`
          // so that function stays synchronous and pure. `authDb` is the right role: the sign-up path
          // already runs as `builderhunt_auth`, and 0147 grants it SELECT on access_requests for
          // exactly this question.
          //
          // Fail CLOSED on a query error. If the allowlist cannot be read while the gate is on, the
          // safe answer is "not allowlisted" — a database hiccup must not reopen public sign-up,
          // which is the whole thing this gate exists to prevent.
          const allowlistEnabled = env.ACCESS_ALLOWLIST_ENABLED === 'true'
          let emailAllowlisted = false
          if (allowlistEnabled) {
            try {
              emailAllowlisted = await isEmailAllowed(authDb, user.email)
            } catch (error) {
              console.error('[access-allowlist] lookup failed; refusing sign-up (fail-closed)', error)
              emailAllowlisted = false
            }
          }

          try {
            checkSignupEmailGate({
              email: user.email,
              blockDisposable: env.SIGNUP_BLOCK_DISPOSABLE_EMAILS === 'true',
              allowlistEnabled,
              emailAllowlisted,
            })
          } catch (error) {
            if (error instanceof DisposableEmailRejectedError) {
              throw new APIError('BAD_REQUEST', { message: error.message, code: 'DISPOSABLE_EMAIL_NOT_ALLOWED' })
            }
            if (error instanceof AccessNotAllowlistedError) {
              throw new APIError('FORBIDDEN', { message: error.message, code: 'ACCESS_NOT_ALLOWLISTED' })
            }
            throw error
          }

          // Device-keyed sign-up velocity (Phase 3 "Device/ASN sign-up velocity + linked-account
          // clustering") — survives IP rotation, unlike better-auth's own built-in per-IP sign-up
          // limiter (`rateLimit` config below, `/sign-up/email: 10/day`). No `user.userAgent`
          // field exists (unlike `session.userAgent`, which better-auth populates itself), so the
          // UA comes straight off the request headers on `context`. Cookie read/issue here mirrors
          // `handleSessionBefore`'s pattern exactly, since this fires before that hook and needs
          // the same first-party device cookie for a consistent fingerprint at signup time.
          if (context) {
            const cookies = cookieAdapterFor(context)
            let deviceCookieValue = cookies.get(DEVICE_COOKIE_NAME)
            if (!deviceCookieValue) {
              deviceCookieValue = issueDeviceCookieValue()
              cookies.set(DEVICE_COOKIE_NAME, deviceCookieValue, {
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
                path: '/',
                maxAge: 60 * 60 * 24 * 365,
              })
              pendingSignupDeviceCookie.set(context, deviceCookieValue)
            }
            const headers = context.headers ?? context.request?.headers
            const uaFamily = detectUaFamily(headers?.get('user-agent') ?? null)
            const deviceHash = computeDeviceHash(deviceCookieValue, uaFamily, env.BETTER_AUTH_SECRET ?? 'dev-secret-change-in-production')
            const gate = await rateLimit('signup-device', deviceHash, env.SIGNUP_DEVICE_DAILY_LIMIT, 60 * 60 * 24)
            if (!gate.allowed) {
              throw new APIError('TOO_MANY_REQUESTS', {
                message: 'Too many accounts created from this device recently. Please try again later.',
                code: 'SIGNUP_DEVICE_RATE_LIMITED',
              })
            }
          }
        },
        after: async (user) => {
          await ensurePersonalOrganization(user.id)
        },
      },
    },
    // better-auth's organization plugin never auto-populates a new
    // session's activeOrganizationId — it must be set explicitly (see
    // node_modules/better-auth/dist/plugins/organization/organization.mjs,
    // which only reads it, never assigns it). Without this hook every
    // signed-in user has no active organization and every tenant-scoped
    // route 403s via requireTenantPrincipal. Default to the user's earliest
    // membership (their personal workspace, created at signup).
    //
    // On a brand-new sign-up this hook fires before `ensurePersonalOrganization`
    // (`user.create.after`) has actually run: better-auth's sign-up endpoint
    // wraps user creation AND session creation in one `runWithTransaction`,
    // and `create.after` hooks are queued via `queueAfterTransactionHook`
    // (node_modules/@better-auth/core/dist/context/transaction.mjs) to fire
    // only after that whole wrapped function resolves — which includes this
    // very session-creation call. So the first lookup below reliably finds
    // no membership yet. `ensurePersonalOrganization` is idempotent (its SQL
    // uses `ON CONFLICT ... DO NOTHING`), so calling it here and re-querying
    // is safe and self-healing regardless of better-auth's internal hook
    // ordering, without adding a DB round trip to the common (existing-user
    // sign-in) path.
    session: {
      create: {
        before: async (session, context) => {
          // Device recognition (abuse-and-usage-integrity plan, Phase 1
          // "Register device + count concurrency on session create") — must
          // run here, not in `after`: cookie writes from `after` never reach
          // the response (verified empirically, see session-hooks.ts).
          if (context) {
            const cookies = cookieAdapterFor(context)
            // If `user.create.before` already issued a device cookie earlier in this exact
            // request (brand-new sign-up), reuse it — `context.getCookie` only reads the
            // original incoming request, so without this override this hook would issue a
            // SECOND, different `bh_did` value, leaving two conflicting `Set-Cookie` headers
            // (browsers keep only the last one) and disagreeing device identities.
            const alreadyIssued = pendingSignupDeviceCookie.get(context)
            const device = await handleSessionBefore(
              { userId: session.userId, userAgent: (session.userAgent as string | null | undefined) ?? null },
              alreadyIssued ? { get: (name) => (name === DEVICE_COOKIE_NAME ? alreadyIssued : cookies.get(name)), set: cookies.set } : cookies,
            )
            pendingSessionDevices.set(context, device)
          }

          if (session.activeOrganizationId) return
          let organizationId = await pickDefaultActiveOrganizationId(session.userId)
          if (!organizationId) {
            await ensurePersonalOrganization(session.userId)
            organizationId = await pickDefaultActiveOrganizationId(session.userId)
          }
          if (!organizationId) return
          return { data: { activeOrganizationId: organizationId } }
        },
        // Concurrent-session signal + (under ABUSE_ENFORCEMENT_MODE=enforce)
        // one-in-one-out revocation — needs `session.id`, which only exists
        // once the row is created. `handleSessionAfter` only decides policy;
        // this file performs the actual `auth_sessions` delete (auth-db
        // allowlist) so the abuse module never touches auth tables directly.
        after: async (session, context) => {
          const device = context ? pendingSessionDevices.get(context) : undefined
          if (!device) return
          const liveSessions = await authDb.select({
            id: authSessions.id,
            token: authSessions.token,
            createdAt: authSessions.createdAt,
          }).from(authSessions)
            .where(and(eq(authSessions.userId, session.userId), gt(authSessions.expiresAt, new Date())))
          const otherLiveSessions = liveSessions.filter((row) => row.id !== session.id)
          const { revokedSessionId } = await handleSessionAfter({
            id: session.id,
            userId: session.userId,
            activeOrganizationId: (session.activeOrganizationId as string | null | undefined) ?? null,
            liveSessionCount: liveSessions.length,
          }, device, otherLiveSessions)
          if (revokedSessionId) {
            await authDb.delete(authSessions).where(eq(authSessions.id, revokedSessionId))
          }
        },
      },
    },
  },
  // BETTER_AUTH_SECRET is the canonical name
  secret: env.BETTER_AUTH_SECRET ?? 'dev-secret-change-in-production',
  baseURL: env.APP_URL,
  plugins: [
    organization({
      ...organizationOptions,
      schema: {
        organization: {
          modelName: 'organization',
          fields: {
            name: 'name',
            slug: 'slug',
            logo: 'logo',
            metadata: 'metadata',
            createdAt: 'createdAt',
          },
        },
        member: {
          modelName: 'member',
          fields: {
            organizationId: 'organizationId',
            userId: 'userId',
            role: 'role',
            createdAt: 'createdAt',
          },
        },
        invitation: {
          modelName: 'invitation',
          fields: {
            organizationId: 'organizationId',
            email: 'email',
            role: 'role',
            status: 'status',
            expiresAt: 'expiresAt',
            createdAt: 'createdAt',
            inviterId: 'inviterId',
          },
        },
        session: { fields: { activeOrganizationId: 'activeOrganizationId' } },
      },
      sendInvitationEmail: async ({ id, email, organization: invitedOrganization }) => {
        const invitationUrl = new URL(`/team/invite/${encodeURIComponent(id)}`, env.APP_URL).toString()
        const result = await sendOrganizationInvitationEmail(email, invitedOrganization.name, invitationUrl)
        if (!result.ok) throw new Error('Unable to deliver organization invitation')
      },
    }),
  ],
  // Cookies are handled via standard browser cookie mechanism
  // Rate limiting: better-auth only enables this by default in production
  // (NODE_ENV === 'production'). We force it on everywhere so brute-force
  // sign-in and mass sign-up are always guarded, and tighten the two
  // sensitive endpoints to the limits called for in the production
  // infrastructure plan (20/min per IP for sign-in, 10/day for sign-up).
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60, max: 20 },
      '/sign-up/email': { window: 60 * 60 * 24, max: 10 },
    },
  },
})
