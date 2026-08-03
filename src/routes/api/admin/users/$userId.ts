import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
  requireRecentPlatformAdminAuthentication,
} from '~/shared/lib/auth/platform-admin'
import { getPlatformUserBillingSummary } from '~/shared/lib/repositories/platform-billing'
import { grantOrganizationEntitlement, OperatorGrantError } from '~/shared/lib/repositories/operator-grants'

/**
 * `pro_max` stays out, deliberately — and this was nearly changed by mistake.
 *
 * The canonical grant path *can* write it (`EntitlementTier` includes it, unlike the legacy `PlanTier`), so the
 * first version of this route added it, reasoning that the omission was an artefact of the old type rather than
 * a decision. `tests/unit/routes/api/admin/users/$userId.test.ts` says otherwise, by name: "never accepts
 * pro_max — Stripe-only, not manually grantable". A named assertion is a policy until someone changes it on
 * purpose, so it stands.
 *
 * **Recorded because the policy looks inconsistent and may be worth revisiting:** the plans do not state a
 * rationale anywhere, and if the reason were "too much value to hand out", `team` should be excluded first — it
 * carries 2100 monthly credits against `pro_max`'s 700, and `team` *is* grantable. So the exclusion may be
 * accidental. That is a pricing decision, not a refactor, and it is not this change's to make.
 */
const UpdateBody = z.object({
  plan: z.enum(['free', 'pro', 'team']),
  planEndsAt: z.string().optional(),
  reason: z.string().max(500).optional(),
})

/**
 * The operator grant: a platform admin setting what an account is entitled to, with no Stripe subscription
 * behind it.
 *
 * ## The subject changed, and that is the fix rather than a side effect
 *
 * This used to call `setUserPlan`, writing the per-**user** `plans` table. That predates organizations and is
 * ambiguous once they exist: entitlement is enforced per organization, so "give this user pro" had no single
 * answer for a user in more than one workspace — the product had to guess. Two teammates could hold different
 * plans in the same workspace and only one of them could be true.
 *
 * It now resolves the organization the user **owns** — through `platform_admin_user_billing_summary`, the same
 * SECURITY DEFINER function the admin Users list already reads — and grants against that. The response and the
 * audit row both name it, so the operator can see which subject moved instead of trusting that "user" meant what
 * they assumed.
 *
 * ## Owning no organization is a refusal, not a silent success
 *
 * A user with no owned organization has nothing to be entitled to. The legacy path would happily write a `plans`
 * row for them, which then applied to nothing — an entitlement floating free of any workspace, invisible to
 * every enforcement check. 409 with the reason instead.
 *
 * ## Seats are not a parameter
 *
 * `grantOrganizationEntitlement` derives the seat limit from the tier, so `SeatLimitExceededError` no longer
 * arises here: the legacy path accepted a plan and then refused if the user's workspace already held more members
 * than it allowed. Granting a smaller tier now sets that tier's limit and leaves the members in place; the next
 * invitation is refused by the ordinary seat check, which is the honest place for that conversation. An operator
 * downgrading an account should not have to dismantle a team first.
 */
export const Route = createFileRoute('/api/admin/users/$userId')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH']),

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          requireRecentPlatformAdminAuthentication(principal)
          const body = await request.json().catch(() => ({}))
          const parsed = UpdateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          const summary = await getPlatformUserBillingSummary(params.userId)
          if (!summary) {
            // Explicit rather than a generic 404: the user may well exist, and saying so is not a leak to a
            // platform admin. What they need to know is that there is no workspace to grant to.
            await auditPlatformAdminAction(principal, {
              action: 'admin.user.entitlement-grant',
              targetType: 'user',
              targetId: params.userId,
              result: 'denied',
              details: { reason: 'no_organization', to: parsed.data.plan },
            })
            return Response.json(
              { error: 'This user owns no organization, so there is nothing to grant an entitlement to' },
              { status: 409 },
            )
          }

          const granted = await grantOrganizationEntitlement({
            organizationId: summary.organizationId,
            tier: parsed.data.plan,
            notes: parsed.data.reason ?? null,
            trialEndsAt: parsed.data.planEndsAt ? new Date(parsed.data.planEndsAt) : null,
          })

          await auditPlatformAdminAction(principal, {
            action: 'admin.user.entitlement-grant',
            targetType: 'organization',
            targetId: summary.organizationId,
            result: 'allowed',
            // `onBehalfOfUserId` because the operator acted from a user row while the change landed on an
            // organization — an auditor reading this later needs both ends of that indirection.
            details: {
              from: summary.entitlementTier,
              to: granted.tier,
              onBehalfOfUserId: params.userId,
              organizationName: summary.organizationName,
            },
          })

          return Response.json({
            ok: true,
            organizationId: granted.organizationId,
            organizationName: summary.organizationName,
            from: summary.entitlementTier,
            to: granted.tier,
            seatLimit: granted.seatLimit,
            trialEndsAt: granted.trialEndsAt,
          })
        } catch (err) {
          if (err instanceof OperatorGrantError) {
            return Response.json({ error: err.message, code: err.code }, { status: 409 })
          }
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin user patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
