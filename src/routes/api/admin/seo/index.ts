import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
} from '~/shared/lib/auth/platform-admin'
import {
  listSurfaceIndexingForAdmin,
  setSurfaceDirectives,
} from '~/shared/lib/repositories/public-surface-indexing'
import { SEO_SURFACES } from '~/shared/lib/seo/surfaces'

const UpdateBody = z.object({
  // Only a surface the registry knows about — an arbitrary string would create a
  // row nothing reads and imply a setting that does not exist.
  surface: z.enum(SEO_SURFACES),
  noindex: z.boolean(),
  nofollow: z.boolean(),
})

export const Route = createFileRoute('/api/admin/seo/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          return Response.json(await listSurfaceIndexingForAdmin())
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin seo list error:', err)
          return Response.json([])
        }
      },
      PATCH: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = UpdateBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          const { surface, noindex, nofollow } = parsed.data
          const updated = await setSurfaceDirectives(surface, { noindex, nofollow }, principal.userId)
          await auditPlatformAdminAction(principal, {
            action: 'admin.seo.update',
            targetType: 'seo_surface',
            targetId: surface,
            result: 'allowed',
            // Directive values are not sensitive and are visible in the page
            // source anyway — recording them is what makes the trail useful.
            details: { noindex, nofollow },
          })
          return Response.json({ surface, ...updated })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin seo patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
