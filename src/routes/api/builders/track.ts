import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { randomId } from '~/lib/utils'
import { recordIngestedSourceObservations, upsertEmbeddingStubs } from '~/lib/semantic/index-writer'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { PLAN_LIMITS } from '~/shared/lib/billing-shared'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { log } from '~/shared/lib/log'
import { getOrganizationEntitlement, resolveLegacyPlanTier } from '~/shared/lib/repositories/entitlements'
import {
  countOrganizationBuilders,
  findOrganizationBuilderBySource,
  trackOrganizationBuilder,
} from '~/shared/lib/repositories/organization-builders'
import { isAllowedBuilderProfileUrl } from '~/shared/lib/security/url-policy'
import { isSuppressed } from '~/shared/lib/profile-suppression'

const TrackBody = z.object({
  source: z.enum([
    'github', 'reddit', 'hn', 'devto', 'lobsters', 'stackoverflow',
    'npm', 'huggingface', 'gitlab', 'codeberg', 'hashnode', 'sourcehut',
  ]),
  sourceId: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  profileUrl: z.string().min(1),
  followersCount: z.number().nullable().optional(),
  language: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  score: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine((data) => isAllowedBuilderProfileUrl(data.source, data.profileUrl), {
  path: ['profileUrl'],
  message: 'Profile URL does not match the declared source',
})

export const Route = createFileRoute('/api/builders/track')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const parsed = TrackBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          if (await isSuppressed(parsed.data.source, parsed.data.sourceId)) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }
          const result = await withTenantContext(principal, async (tx) => {
            const [entitlement, current, existing] = await Promise.all([
              getOrganizationEntitlement(tx, principal.organizationId),
              countOrganizationBuilders(tx, principal.organizationId),
              findOrganizationBuilderBySource(
                tx,
                principal.organizationId,
                parsed.data.source,
                parsed.data.sourceId,
              ),
            ])
            const limit = PLAN_LIMITS[resolveLegacyPlanTier(entitlement.tier)].savedBuilders
            if (!existing && current >= limit) return { tracked: null, current, limit, plan: entitlement.tier }
            const tracked = await trackOrganizationBuilder(tx, {
              id: randomId(),
              organizationId: principal.organizationId,
              creatorUserId: principal.userId,
              ...parsed.data,
            })
            return { tracked, current, limit, plan: entitlement.tier }
          })
          if (!result.tracked) {
            return Response.json({
              error: `You've reached the ${result.plan} plan limit of ${result.limit} saved builders. Upgrade to save more.`,
              current: result.current,
              limit: result.limit,
              plan: result.plan,
              upgradeUrl: '/pricing',
            }, { status: 402 })
          }
          // Write-through indexing for semantic-search — fire-and-forget,
          // never awaited on the response (see src/lib/semantic/index-writer.ts).
          upsertEmbeddingStubs([parsed.data]).catch((err) => log.error('embedding_writethrough_error', { error: err instanceof Error ? err.message : String(err) }))
          recordIngestedSourceObservations([parsed.data]).catch((err) => log.error('source_observation_writethrough_error', { error: err instanceof Error ? err.message : String(err) }))
          return Response.json({ id: result.tracked.id, tracked: true })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Track builder error:', error)
          return Response.json({ error: 'Failed to track builder' }, { status: 500 })
        }
      },
    },
  },
})
