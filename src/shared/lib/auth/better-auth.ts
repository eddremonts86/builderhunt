import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { db } from '~/shared/lib/db'
import { authUsers, authSessions, authAccounts } from '~/shared/lib/db/schema'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: authUsers,
      session: authSessions,
      account: authAccounts,
    },
  }),
  emailAndPassword: { enabled: true },
  secret: process.env.AUTH_SECRET ?? 'dev-secret-change-in-production',
  baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  // Cookies are handled via standard browser cookie mechanism
})