import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auditPlatformAdminAction, platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { deletePlatformChangelog, updatePlatformChangelog } from '~/shared/lib/repositories/platform-content'

const UpdateBody = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  slug: z.string().optional(),
})

export const Route = createFileRoute('/api/admin/changelog/$id')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['PATCH', 'DELETE']),

      PATCH: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const body = await request.json().catch(() => ({}))
          const parsed = UpdateBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })
          const updated = await updatePlatformChangelog(params.id, parsed.data)
          if (!updated) return Response.json({ error: 'Not found' }, { status: 404 })
          await auditPlatformAdminAction(principal, {
            action: 'admin.changelog.update',
            targetType: 'changelog',
            targetId: params.id,
            result: 'allowed',
          })
          return Response.json(updated)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin changelog patch error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          await deletePlatformChangelog(params.id)
          await auditPlatformAdminAction(principal, {
            action: 'admin.changelog.delete',
            targetType: 'changelog',
            targetId: params.id,
            result: 'allowed',
          })
          return Response.json({ ok: true })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin changelog delete error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
