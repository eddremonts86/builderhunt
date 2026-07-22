import { betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
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
import { organizationOptions } from './organization-options'
import { ensurePersonalOrganization, pickDefaultActiveOrganizationId } from './personal-organization'

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
  databaseHooks: {
    user: {
      create: {
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
        before: async (session) => {
          if (session.activeOrganizationId) return
          let organizationId = await pickDefaultActiveOrganizationId(session.userId)
          if (!organizationId) {
            await ensurePersonalOrganization(session.userId)
            organizationId = await pickDefaultActiveOrganizationId(session.userId)
          }
          if (!organizationId) return
          return { data: { activeOrganizationId: organizationId } }
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
