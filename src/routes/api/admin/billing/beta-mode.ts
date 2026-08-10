import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import {
  auditPlatformAdminAction,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import {
  BetaModeRevisionConflictError,
  getPlatformBetaModeState,
  setBetaModeState,
} from '~/shared/lib/billing/beta-mode'

/**
 * The one place beta mode is turned on and off (plan 58).
 *
 * Modelled on `/api/admin/operations/$jobKey`, which already solves the same problem with
 * `expectedVersion` and a `409`. Reusing that shape rather than inventing one keeps the admin surface
 * predictable and means the client-side conflict handling is the same story twice.
 */
const bodySchema = z
  .object({
    enabled: z.boolean(),
    expectedRevision: z.number().int().min(0),
  })
  // `.strict()`, so a client that sends `{ enabled, revision }` — the field name it is easy to guess
  // wrong — is told rather than silently writing with `expectedRevision: undefined`.
  .strict()

export const Route = createFileRoute('/api/admin/billing/beta-mode')({
  component: () => null,
  server: {
    handlers: {
      ANY: methodNotAllowed(['GET', 'PUT']),

      GET: async ({ request }) => {
        // Read needs platform admin but **not** recent re-authentication: it changes nothing, and forcing
        // a re-auth to look at a status is how operators learn to keep a tab logged in.
        await requirePlatformAdminPrincipal(request)
        const state = await getPlatformBetaModeState()
        return Response.json({
          enabled: state.enabled,
          revision: state.revision,
          updatedAt: state.updatedAt.toISOString(),
          updatedBy: state.updatedBy,
        })
      },

      PUT: async ({ request }) => {
        const principal = await requirePlatformAdminPrincipal(request)
        // The write does require it. This grants every organization in the system paid-tier product
        // access; it belongs with the other actions that need a fresh proof of identity.
        requireRecentPlatformAdminAuthentication(principal)

        const parsed = bodySchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) {
          return Response.json(
            { error: 'enabled (boolean) and expectedRevision (integer) are required' },
            { status: 400 },
          )
        }

        const before = await getPlatformBetaModeState()

        try {
          const state = await setBetaModeState({
            enabled: parsed.data.enabled,
            expectedRevision: parsed.data.expectedRevision,
            updatedBy: principal.userId,
          })

          /**
           * Audited only on a real transition.
           *
           * `setBetaModeState` treats a same-state request as an idempotent no-op, and recording those
           * would fill the trail with events that describe nothing — which is how a trail stops being
           * read. The revision is the discriminator: it only moves when the state did.
           */
          if (state.revision !== before.revision) {
            await auditPlatformAdminAction(principal, {
              action: state.enabled ? 'admin.billing.beta-mode.enable' : 'admin.billing.beta-mode.disable',
              targetType: 'platform_beta_mode',
              targetId: 'global',
              result: 'allowed',
              details: { from: before.enabled, to: state.enabled, revision: state.revision },
            })
          }

          return Response.json({
            enabled: state.enabled,
            revision: state.revision,
            updatedAt: state.updatedAt.toISOString(),
            updatedBy: state.updatedBy,
          })
        } catch (error) {
          if (error instanceof BetaModeRevisionConflictError) {
            /**
             * The current state travels with the 409.
             *
             * A bare conflict leaves the screen with nothing to do but refetch, and a screen that
             * refetches on conflict can loop. Returning the winning document lets it adopt reality in the
             * same round trip.
             */
            return Response.json(
              {
                error: 'revision_conflict',
                enabled: error.current.enabled,
                revision: error.current.revision,
                updatedAt: error.current.updatedAt.toISOString(),
                updatedBy: error.current.updatedBy,
              },
              { status: 409 },
            )
          }
          throw error
        }
      },
    },
  },
})
