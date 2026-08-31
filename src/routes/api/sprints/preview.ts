import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { rateLimit } from '~/shared/lib/rate-limit'
import { searchBuilders, DEFAULT_SEARCH_SOURCES } from '~/lib/search'
import { queryVariantSchema } from '~/shared/lib/sprints-shared'
import { toSprintProfileSnapshot } from '~/lib/sprints/results'
import { decideSelfManagedInclusion, withSelfManagedOrigin } from '~/shared/lib/self-managed/inclusion-policy'
import { getUserPreferences } from '~/shared/lib/repositories/user-preferences'
import { withTenantContext } from '~/shared/lib/db/tenant-context'

const PreviewBody = z.object({
  variants: z.array(queryVariantSchema).min(1).max(4),
}).strict()

export const Route = createFileRoute('/api/sprints/preview')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const rl = await rateLimit('sprint-preview', principal.userId, 10, 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many previews. Try again in a minute.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }
          const parsed = PreviewBody.safeParse(await request.json().catch(() => ({})))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid preview request', details: parsed.error.flatten() }, { status: 400 })
          }

          // Resolved once for the whole preview, from the person previewing: a shortlist that
          // changed policy between two variants would be two different searches in one answer.
          const previewInclusion = decideSelfManagedInclusion({
            accountPreference: (await withTenantContext(principal, (tx) =>
              getUserPreferences(tx, principal.userId))).searchIncludeSelfManaged,
          })

          const seen = new Set<string>()
          const items: { variant: string; profile: ReturnType<typeof toSprintProfileSnapshot>; source: string; sourceId: string; score: number }[] = []
          for (const variant of parsed.data.variants) {
            const results = await searchBuilders({
              keywords: variant.keywords,
              // The preview must be the run: an organiser who sees a shortlist and then gets a
              // different one has been shown a lie, however small.
              sources: withSelfManagedOrigin(variant.sources ?? DEFAULT_SEARCH_SOURCES, previewInclusion),
              language: variant.language,
              country: variant.country,
              perPage: 30,
            })
            for (const person of results.filter((builder) => builder.kind === 'person')) {
              const key = `${person.source}:${person.sourceId}`
              if (seen.has(key)) continue
              seen.add(key)
              items.push({ variant: variant.name, source: person.source, sourceId: person.sourceId, score: person.score, profile: toSprintProfileSnapshot(person) })
            }
          }

          return Response.json({ items })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Sprint preview error:', error)
          return Response.json({ error: 'Failed to preview sprint' }, { status: 500 })
        }
      },
    },
  },
})
