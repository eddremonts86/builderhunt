/**
 * Public Radars share/unshare API (plan: public-landing-pages, Phase 2).
 *
 * POST: publish a saved query as a public, SSR'd radar at `/r/$slug` (idempotent
 * — re-sharing an already-shared query returns its existing slug). DELETE:
 * unpublish it. Both require the caller's tenant to own the saved query;
 * `public_radars` itself carries no RLS (see schema.ts's comment on the
 * table), so ownership is enforced here, in application code, before ever
 * touching it.
 */
import { createFileRoute } from '@tanstack/react-router'
import { randomId } from '~/lib/utils'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { findSavedQueryById } from '~/shared/lib/repositories/saved-queries'

// `~/shared/lib/repositories/public-radars` imports `publicDb`, which eagerly
// opens a real `postgres()` client at module scope — imported dynamically
// inside each handler below (not statically here) to keep that chain out of
// the client bundle. See the matching note in src/lib/sources/devpost.ts.
type PublicRadarsModule = typeof import('~/shared/lib/repositories/public-radars')

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'radar'
}

async function generateUniqueSlug(name: string, findPublicRadarBySlug: PublicRadarsModule['findPublicRadarBySlug']): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = `${slugify(name)}-${randomId().slice(0, 6)}`
    if (!(await findPublicRadarBySlug(slug))) return slug
  }
  return `radar-${randomId().slice(0, 10)}`
}

export const Route = createFileRoute('/api/queries/$id/share')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const query = await withTenantContext(principal, (tx) =>
            findSavedQueryById(tx, principal.organizationId, params.id),
          )
          if (!query) return Response.json({ error: 'Saved search not found' }, { status: 404 })

          const { createPublicRadar, findPublicRadarBySavedQueryId, findPublicRadarBySlug } =
            await import('~/shared/lib/repositories/public-radars')

          const existing = await findPublicRadarBySavedQueryId(params.id)
          if (existing) {
            return Response.json({ slug: existing.slug, url: `/r/${existing.slug}` })
          }

          const slug = await generateUniqueSlug(query.name, findPublicRadarBySlug)
          const radar = await createPublicRadar(principal.organizationId, params.id, slug)
          return Response.json({ slug: radar.slug, url: `/r/${radar.slug}` })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Radar share error:', error)
          return Response.json({ error: 'Failed to share search' }, { status: 500 })
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const query = await withTenantContext(principal, (tx) =>
            findSavedQueryById(tx, principal.organizationId, params.id),
          )
          if (!query) return Response.json({ error: 'Saved search not found' }, { status: 404 })

          const { deletePublicRadar } = await import('~/shared/lib/repositories/public-radars')
          const deleted = await deletePublicRadar(principal.organizationId, params.id)
          if (!deleted) return Response.json({ error: 'Not shared' }, { status: 404 })
          return Response.json({ success: true })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Radar unshare error:', error)
          return Response.json({ error: 'Failed to unshare search' }, { status: 500 })
        }
      },
    },
  },
})
