/**
 * Platform-admin claim management projection (plans/UI/tasks.md Wave 4 "Build platform-admin claim
 * management projection"). Bounded cursor pagination and allowlisted filters over
 * `listBuilderClaimsForAdmin` — no raw proof tokens (`verificationSecretHash`) or metadata jsonb
 * ever leave the repository layer; only the derived `portfolioPublished` boolean does.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { publicDb } from '~/shared/lib/db/client'
import { listBuilderClaimsForAdmin, type BuilderClaimStatus } from '~/shared/lib/repositories/builder-claims'

const STATUSES = ['pending', 'verified', 'rejected', 'revoked', 'expired'] as const

const QuerySchema = z.object({
  status: z.string().optional(), // comma-separated subset of STATUSES
  source: z.string().optional(),
  subjectUserId: z.string().optional(),
  verifiedFrom: z.string().datetime().optional(),
  verifiedTo: z.string().datetime().optional(),
  portfolioPublished: z.enum(['true', 'false']).optional(),
  before: z.string().datetime().optional(),
  id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  (q) => (q.before === undefined) === (q.id === undefined),
  { message: 'before and id must be supplied together' },
)

export const Route = createFileRoute('/api/admin/builder-claims/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const url = new URL(request.url)
          const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_query', issues: parsed.error.issues }, { status: 422 })
          }
          const q = parsed.data

          const status = q.status
            ?.split(',')
            .map((s) => s.trim())
            .filter((s): s is BuilderClaimStatus => (STATUSES as readonly string[]).includes(s))

          const result = await listBuilderClaimsForAdmin(publicDb, {
            status: status && status.length > 0 ? status : undefined,
            source: q.source,
            subjectUserId: q.subjectUserId,
            verifiedFrom: q.verifiedFrom ? new Date(q.verifiedFrom) : undefined,
            verifiedTo: q.verifiedTo ? new Date(q.verifiedTo) : undefined,
            portfolioPublished: q.portfolioPublished === undefined ? undefined : q.portfolioPublished === 'true',
            before: q.before && q.id ? { createdAt: new Date(q.before), id: q.id } : undefined,
            limit: q.limit,
          })

          await auditPlatformAdminAction(principal, {
            action: 'admin.builder-claims.list',
            targetType: 'builder-claim',
            targetId: null,
            result: 'allowed',
            details: { count: result.rows.length, status: q.status ?? null, source: q.source ?? null },
          })

          return Response.json(result)
        } catch (error) {
          const response = platformAdminErrorResponse(error)
          if (response) return response
          console.error('admin builder-claims list error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
