import { createFileRoute } from '@tanstack/react-router'
import { randomId } from '~/lib/utils'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { env } from '~/shared/lib/env'
import { rateLimit } from '~/shared/lib/rate-limit'
import { buildClaimInstructions, CLAIM_CHALLENGE_TTL_MS, generateClaimChallenge } from '~/shared/lib/claims'
import { isClaimSourceSupported } from '~/shared/lib/claim-sources'
import {
  createPendingBuilderClaim,
  findPendingBuilderClaim,
  getBuilderIdentitySourceInfo,
} from '~/shared/lib/repositories/builder-claims'
import { isClaimExpired } from '~/shared/lib/claims'

/**
 * Starts a claim. Unlike the flow this replaced, there is no email step at
 * all: the "proof" that mattered was never really the email (an app-session
 * email matching text the user typed proves nothing about controlling the
 * *external* GitHub/GitLab/Codeberg/DEV.to account being claimed) — it's a
 * public challenge string the claimant must publish on the account itself,
 * checked by `POST .../claim/verify`.
 */
export const Route = createFileRoute('/api/builders/$builderId/claim')({
  component: () => null,
  server: {
    handlers: {
      /** Re-fetches the caller's own in-flight challenge — lets the claim panel survive a page reload without re-minting (and racing) a second pending claim on the same identity. */
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const pending = await withTenantContext(principal, (tx) =>
            findPendingBuilderClaim(tx, { subjectUserId: principal.userId, builderIdentityId: params.builderId }),
          )
          if (!pending || isClaimExpired(pending.expiresAt)) return Response.json({ pending: false })
          return Response.json({
            pending: true,
            source: pending.evidenceSource,
            challenge: pending.evidenceReference,
            instructions: buildClaimInstructions(pending.evidenceSource, pending.evidenceReference),
            expiresAt: pending.expiresAt,
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Claim status error:', error)
          return Response.json({ error: 'Failed to read claim status' }, { status: 500 })
        }
      },
      POST: async ({ request, params }) => {
        try {
          if (env.CLAIMABLE_PROFILES_ENABLED === 'false') {
            return Response.json({ error: 'Claiming is temporarily unavailable' }, { status: 503 })
          }
          const principal = await requireTenantPrincipal(request)

          const rl = await rateLimit(
            'builder-claim',
            `${principal.userId}:${params.builderId}`,
            5,
            24 * 60 * 60,
          )
          if (!rl.allowed) {
            return Response.json(
              { error: 'Rate limit exceeded. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const identityInfo = await withTenantContext(principal, (tx) =>
            getBuilderIdentitySourceInfo(tx, params.builderId),
          )
          if (!identityInfo) return Response.json({ error: 'Builder not found' }, { status: 404 })
          if (!isClaimSourceSupported(identityInfo.source)) {
            return Response.json({ error: 'unsupported_source' }, { status: 400 })
          }

          // Re-issuing for the caller's own already-pending claim, rather than
          // erroring on the unique-active-claim-per-identity constraint below,
          // is what makes "reopen the claim panel" idempotent instead of a 409.
          const existing = await withTenantContext(principal, (tx) =>
            findPendingBuilderClaim(tx, { subjectUserId: principal.userId, builderIdentityId: params.builderId }),
          )
          if (existing && !isClaimExpired(existing.expiresAt)) {
            return Response.json({
              ok: true,
              source: existing.evidenceSource,
              username: identityInfo.username,
              challenge: existing.evidenceReference,
              instructions: buildClaimInstructions(existing.evidenceSource, existing.evidenceReference),
              expiresAt: existing.expiresAt,
            })
          }

          const challenge = generateClaimChallenge()
          const expiresAt = new Date(Date.now() + CLAIM_CHALLENGE_TTL_MS)
          const claim = await withTenantContext(principal, (tx) => createPendingBuilderClaim(tx, {
            id: randomId(),
            builderIdentityId: params.builderId,
            subjectUserId: principal.userId,
            evidenceSource: identityInfo.source,
            evidenceReference: challenge,
            verificationSecretHash: null,
            expiresAt,
          }))
          if (!claim) return Response.json({ error: 'Builder not found' }, { status: 404 })

          return Response.json({
            ok: true,
            source: identityInfo.source,
            username: identityInfo.username,
            challenge,
            instructions: buildClaimInstructions(identityInfo.source, challenge),
            expiresAt: expiresAt.toISOString(),
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          if (isUniqueViolation(error)) {
            return Response.json({ error: 'This profile already has an active claim' }, { status: 409 })
          }
          console.error('Claim error:', error)
          return Response.json({ error: 'Failed to process claim' }, { status: 500 })
        }
      },
    },
  },
})

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
