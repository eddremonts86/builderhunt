import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { getOnboardingStatus } from '~/shared/lib/onboarding'
import {
  advanceOnboarding,
  countActivationEvidence,
  getOnboardingV2State,
  recordActivation,
  toStatusV2,
} from '~/shared/lib/onboarding-v2-repository'
import { onboardingActionSchema } from '~/shared/lib/onboarding-api'
import { isInOnboardingV2Cohort, parseRolloutPercent } from '~/shared/lib/onboarding-rollout'
import { env } from '~/shared/lib/env'

/**
 * The cohort decision, made on the server and answered to the client.
 *
 * Both flows are live, so the rollout is a choice of route rather than a deploy: `welcome` sends
 * somebody in the cohort to the goal step and everybody else to v1's search step. Deciding it here
 * means a client cannot opt itself in, and means the percentage is read from one place.
 */
function rolloutFor(userId: string): { inCohort: boolean; percent: number } {
  const percent = parseRolloutPercent(env.ONBOARDING_V2_ROLLOUT_PERCENT)
  return { inCohort: isInOnboardingV2Cohort(userId, percent), percent }
}

/**
 * Onboarding v2 (plan: phase-2/03-onboarding-segmentado).
 *
 * A new path rather than a changed one. `/api/onboarding/status`, `/complete` and `/skip` keep
 * answering v1 exactly as before, so the rollout is a client-side choice of endpoint and a rollback
 * is the same choice made the other way — no deploy, no migration, nobody stranded mid-flow.
 *
 * The segment is read from `user_preferences` on the server and the identity from the session.
 * Neither can be named in a request: `onboardingActionSchema` is `.strict()` and its union has no
 * field for either, so a body that tries is a 400 rather than a value quietly ignored.
 */
export const Route = createFileRoute('/api/onboarding/v2/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const payload = await withTenantContext(principal, async (tx) => {
            const [state, v1] = await Promise.all([
              getOnboardingV2State(tx, principal.organizationId, principal.userId),
              // Eligibility is still v1's to decide — the window, the skip ceiling and the
              // "already an active member" checks are unchanged by segmentation, and duplicating
              // them here would create two answers to one question.
              getOnboardingStatus(tx, principal.organizationId, principal.userId),
            ])
            return toStatusV2(state, v1.eligible, rolloutFor(principal.userId))
          })
          return Response.json(payload)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Onboarding v2 status error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const body: unknown = await request.json().catch(() => null)
          const parsed = onboardingActionSchema.safeParse(body)
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
              { status: 400 },
            )
          }
          const action = parsed.data

          const result = await withTenantContext(principal, async (tx) => {
            if (action.action === 'advance') {
              const advanced = await advanceOnboarding(
                tx, principal.organizationId, principal.userId, action.from,
              )
              const v1 = await getOnboardingStatus(tx, principal.organizationId, principal.userId)
              return { advanced, payload: toStatusV2(advanced.state, v1.eligible, rolloutFor(principal.userId)) }
            }

            if (action.action === 'activate') {
              /**
               * The evidence is counted on the server, not supplied.
               *
               * A client that could assert "I saved three builders" could assert it having saved
               * none, and the activation rate — the number this whole plan exists to make
               * trustworthy — would be the first casualty.
               */
              const v1 = await getOnboardingStatus(tx, principal.organizationId, principal.userId)
              const evidence = await countActivationEvidence(
                tx,
                principal.organizationId,
                principal.userId,
                v1.firstBuilderIds.length,
              )
              await recordActivation(
                tx,
                principal.organizationId,
                principal.userId,
                evidence,
                action.refId ?? null,
              )
              const state = await getOnboardingV2State(tx, principal.organizationId, principal.userId)
              return { advanced: null, payload: toStatusV2(state, v1.eligible, rolloutFor(principal.userId)) }
            }

            // `skip` stays v1's, deliberately: the skip ceiling and its counter are unchanged by
            // segmentation, and a second implementation would let the two disagree about how many
            // skips somebody has left.
            const state = await getOnboardingV2State(tx, principal.organizationId, principal.userId)
            const v1 = await getOnboardingStatus(tx, principal.organizationId, principal.userId)
            return { advanced: null, payload: toStatusV2(state, v1.eligible, rolloutFor(principal.userId)) }
          })

          if (result.advanced && !result.advanced.ok) {
            /**
             * 409, not 400. The request was well-formed; the state moved underneath it. A client
             * that gets 409 should re-read and re-render, and one that gets 400 should fix its code
             * — collapsing them would make a retry loop indistinguishable from a bug.
             */
            return Response.json(
              { error: result.advanced.reason, state: result.payload },
              { status: 409 },
            )
          }

          return Response.json(result.payload)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Onboarding v2 action error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
