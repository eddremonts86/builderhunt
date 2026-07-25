/**
 * Project Hygiene API (plan: project-hygiene, Phase 3).
 *
 * GET real per-repo hygiene signals for a tracked GitHub builder, computed
 * from live GitHub data (issues, docs, CI) rather than the client-side
 * heuristic estimate. Non-GitHub builders (and any failure along the way)
 * resolve to `{ estimated: true }` so the card falls back to its existing
 * heuristic — this endpoint never throws for an expected "can't do this"
 * case, only for genuine errors.
 *
 * Persistence: `organization_builders.privateMetadata.projectHygiene`, keyed
 * by the calling principal's own organization's tracked-builder row — same
 * ownership model as `enrichment.ts`. 15-day freshness window before
 * re-fetching from GitHub.
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { findOrganizationBuilderByIdentity, setOrganizationBuilderHygiene } from '~/shared/lib/repositories/organization-builders'
import { rateLimit } from '~/shared/lib/rate-limit'
import { computeHygiene, projectHygieneEnvelopeSchema, type ProjectHygieneEnvelope } from '~/shared/lib/hygiene'
import { fetchRepoSignals, GitHubTokenMissingError, GitHubRateLimitedError } from '~/lib/github/repo-signals'

const FRESHNESS_MS = 15 * 24 * 60 * 60 * 1000

function isFresh(envelope: unknown): envelope is ProjectHygieneEnvelope {
  const parsed = projectHygieneEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) return false
  const computedAt = Date.parse(parsed.data.computedAt)
  return !isNaN(computedAt) && Date.now() - computedAt < FRESHNESS_MS
}

export const Route = createFileRoute('/api/builders/$builderId/hygiene')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const tenantBuilder = await withTenantContext(principal, (tx) =>
            findOrganizationBuilderByIdentity(tx, principal.organizationId, params.builderId),
          )
          if (!tenantBuilder) return Response.json({ error: 'Builder not found' }, { status: 404 })

          if (tenantBuilder.source !== 'github') {
            return Response.json({ estimated: true })
          }

          const privateMetadata = tenantBuilder.privateMetadata as Record<string, unknown>
          if (isFresh(privateMetadata.projectHygiene)) {
            return Response.json({ ...(privateMetadata.projectHygiene as ProjectHygieneEnvelope), cached: true })
          }

          const limit = await rateLimit('hygiene', principal.userId, 10, 3600)
          if (!limit.allowed) {
            return Response.json(
              { error: 'rate_limited' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.resetMs / 1000)) } },
            )
          }

          let signals
          try {
            signals = await fetchRepoSignals(tenantBuilder.username)
          } catch (error) {
            if (error instanceof GitHubTokenMissingError) {
              return Response.json({ error: 'github_token_missing' }, { status: 503 })
            }
            if (error instanceof GitHubRateLimitedError) {
              return Response.json({ error: 'github_rate_limited' }, { status: 503 })
            }
            throw error
          }

          if (signals.length === 0) {
            return Response.json({ estimated: true })
          }

          const envelope: ProjectHygieneEnvelope = {
            hygiene: computeHygiene(signals),
            signals,
            computedAt: new Date().toISOString(),
            version: 1,
          }
          await withTenantContext(principal, (tx) =>
            setOrganizationBuilderHygiene(tx, principal.organizationId, params.builderId, envelope),
          )
          return Response.json({ ...envelope, cached: false })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Failed to fetch project hygiene:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
