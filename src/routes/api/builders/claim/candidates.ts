import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { claimSupportedSources } from '~/shared/lib/claim-sources'
import { findClaimCandidatesByHandle } from '~/shared/lib/repositories/builder-claims'
import { isSuppressed } from '~/shared/lib/profile-suppression'

/**
 * "Find me in the index" (plan: phase-2/03-onboarding-segmentado, building branch).
 *
 * The building route asks somebody to locate their own indexed profile so they can claim it, and a
 * claim needs a `builder_identities.id`. Federated search cannot supply one — it returns results
 * from third parties that may not be indexed at all — so this reads the local index.
 *
 * ## Exact handle only
 *
 * A prefix or fuzzy search here would be a handle enumerator for every authenticated account: type
 * one letter, read back everyone indexed. Somebody looking for their own account knows how it is
 * spelled, so exactness costs them nothing. Rate-limited on top of that, because an exact-match
 * endpoint is still a membership oracle if it can be called without bound.
 *
 * ## Suppression is enforced here too
 *
 * `profile-suppression.ts` is the correctness backstop for people who had their profile removed, and
 * every surface that can show an identity has to filter through it. A removal that still answered
 * "yes, that person is indexed" would be a removal in name only.
 */
export const Route = createFileRoute('/api/builders/claim/candidates')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          const handle = (new URL(request.url).searchParams.get('handle') ?? '').trim()
          // Bounded before it reaches SQL: the column is `text`, and an unbounded parameter is a way
          // to make the server do arbitrary work on a comparison that can never match.
          if (!handle || handle.length > 100) {
            return Response.json({ error: 'A handle is required' }, { status: 400 })
          }

          const limitResult = await rateLimit('claim-candidates', `${principal.organizationId}:${principal.userId}`, 60, 60 * 60)
          if (!limitResult.allowed) {
            return Response.json(
              { error: 'Too many lookups in the last hour. Try again later.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limitResult.resetMs / 1000)) } },
            )
          }

          const rows = await withTenantContext(principal, (tx) =>
            findClaimCandidatesByHandle(tx, handle, claimSupportedSources()),
          )

          const visible = []
          for (const row of rows) {
            if (await isSuppressed(row.source, row.sourceId)) continue
            visible.push({
              id: row.id,
              source: row.source,
              username: row.username,
              displayName: row.displayName,
              avatarUrl: row.avatarUrl,
              profileUrl: row.profileUrl,
            })
          }

          return Response.json({ candidates: visible })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Claim candidates error:', error)
          return Response.json({ error: 'Failed to look up profiles' }, { status: 500 })
        }
      },
    },
  },
})
