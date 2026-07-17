import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders, builderClaimRequests, authUsers, authAccounts } from '~/shared/lib/db/schema'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { randomId } from '~/lib/utils'
import { hashPassword } from 'better-auth/crypto'

/**
 * Claim verification endpoint.
 *
 * GET /api/builders/claim/verify?token=X
 *
 * - Validates the token (exists, not expired, not used)
 * - Creates a user account with a random password (they'll reset on first sign-in)
 *   OR reuses an existing user with the same email
 * - Marks the builder as claimed + verified
 * - Marks the claim request as used
 * - Redirects to /auth/sign-in with a flash message
 */

export const Route = createFileRoute('/api/builders/claim/verify')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url)
          const token = url.searchParams.get('token')
          if (!token) {
            return errorResponse('Missing token', 400)
          }

          // 1. Look up the claim request (not expired, not used)
          const [claim] = await db
            .select()
            .from(builderClaimRequests)
            .where(
              and(
                eq(builderClaimRequests.token, token),
                isNull(builderClaimRequests.usedAt),
                gt(builderClaimRequests.expiresAt, new Date()),
              ),
            )
            .limit(1)

          if (!claim) {
            return errorResponse('This claim link is invalid or has expired.', 410)
          }

          // 2. Find or create the user
          const email = claim.email
          let [user] = await db
            .select({ id: authUsers.id })
            .from(authUsers)
            .where(eq(authUsers.email, email))
            .limit(1)

          if (!user) {
            // Create a new user with a random password. The user will need
            // to use "forgot password" or sign-in to set their actual password.
            const newUserId = randomId()
            const tempPassword = randomId() + randomId() // 32+ chars
            await db.insert(authUsers).values({
              id: newUserId,
              name: email.split('@')[0] || 'Builder',
              email,
              emailVerified: true, // they verified via the claim link
            })
            // Create the auth_account row so the user can sign in. The
            // password must be hashed the same way Better Auth hashes it
            // internally — a raw/plaintext value here makes sign-in crash
            // (verifyPassword() throws on a non-hash-shaped string) instead
            // of cleanly rejecting. The user doesn't know this temp password
            // anyway; they're expected to use "Forgot password?" to set one.
            await db.insert(authAccounts).values({
              id: randomId(),
              userId: newUserId,
              accountId: newUserId,
              providerId: 'credential',
              password: await hashPassword(tempPassword),
            })
            user = { id: newUserId }
          }

          // 3. Mark claim as used
          await db
            .update(builderClaimRequests)
            .set({ usedAt: new Date() })
            .where(eq(builderClaimRequests.id, claim.id))

          // 4. Mark builder as claimed + verified
          await db
            .update(builders)
            .set({
              isClaimed: true,
              claimedByUserId: user.id,
              claimedAt: new Date(),
              isVerified: true,
              verifiedAt: new Date(),
            })
            .where(eq(builders.id, claim.builderId))

          // 5. Redirect to sign-in with a flash message
          const params = new URLSearchParams({
            email,
            claimed: '1',
            builderId: claim.builderId,
          })
          return new Response(null, {
            status: 302,
            headers: {
              Location: `/auth/sign-in?${params.toString()}`,
            },
          })
        } catch (err) {
          console.error('Verify claim error:', err)
          return errorResponse('Failed to verify claim', 500)
        }
      },
    },
  },
})

function errorResponse(message: string, status: number): Response {
  const params = new URLSearchParams({ claimError: message })
  return new Response(null, {
    status: 302,
    headers: { Location: `/auth/sign-in?${params.toString()}` },
  })
}
