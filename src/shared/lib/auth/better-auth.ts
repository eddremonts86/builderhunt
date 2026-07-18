import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { db } from '~/shared/lib/db/index'
import { authUsers, authSessions, authAccounts, authVerifications } from '~/shared/lib/db/schema'
import { sendResetPasswordEmail } from '~/shared/lib/email'
import { env } from '~/shared/lib/env'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: authUsers,
      session: authSessions,
      account: authAccounts,
      verification: authVerifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail(user.email, url)
    },
  },
  // BETTER_AUTH_SECRET is the canonical name
  secret: env.BETTER_AUTH_SECRET ?? 'dev-secret-change-in-production',
  baseURL: env.APP_URL,
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