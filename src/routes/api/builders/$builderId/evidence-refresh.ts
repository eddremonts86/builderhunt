/**
 * Public Profile Enrichment — enqueue endpoint (plan: stealth-scraping).
 * Spec §10. Idempotent: an existing active job for this builder is returned
 * instead of creating a duplicate.
 */
import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { randomId } from '~/lib/utils'
import { env } from '~/shared/lib/env'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getExecutableConnectors } from '~/lib/enrichment/registry'
import { EvidenceRefreshBody, MAX_EVIDENCE_REFRESH_BODY_BYTES } from '~/lib/enrichment/schemas'
import {
  enqueueEnrichmentJob,
  findActiveEnrichmentJob,
  findTrackedEnrichmentTarget,
  isBuilderProcessingRestricted,
} from '~/shared/lib/repositories/enrichment'

export const Route = createFileRoute('/api/builders/$builderId/evidence-refresh')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const principal = await requireTenantPrincipal(request)

          if (env.ENRICHMENT_ENABLED !== 'true') {
            return Response.json({ error: 'enrichment_disabled' }, { status: 503 })
          }

          const rawBody = await request.text()
          if (rawBody.length > MAX_EVIDENCE_REFRESH_BODY_BYTES) {
            return Response.json({ error: 'Body too large' }, { status: 413 })
          }
          const parsed = EvidenceRefreshBody.safeParse(JSON.parse(rawBody || '{}'))
          if (!parsed.success) {
            return Response.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
          }

          const rl = await rateLimit('enrichment-refresh', `${principal.organizationId}:${principal.userId}`, 10, 60 * 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many refresh requests this hour' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const result = await withTenantContext(principal, async (tx) => {
            const target = await findTrackedEnrichmentTarget(tx, principal.organizationId, params.builderId)
            if (!target) return { kind: 'not_found' as const }

            if (await isBuilderProcessingRestricted(tx, params.builderId)) {
              return { kind: 'restricted' as const }
            }

            const existing = await findActiveEnrichmentJob(tx, principal.organizationId, params.builderId)
            if (existing) return { kind: 'existing' as const, job: existing }

            const executable = getExecutableConnectors(env.ENRICHMENT_ALLOWED_CONNECTORS, parsed.data.connectors)
            const acceptedConnectors = executable.map((c) => c.id)
            const blockedConnectors = parsed.data.connectors.filter((id) => !acceptedConnectors.includes(id.toLowerCase()))

            const job = await enqueueEnrichmentJob(tx, {
              id: randomId(),
              organizationId: principal.organizationId,
              builderIdentityId: params.builderId,
              requestedByUserId: principal.userId,
              trigger: 'manual',
              requestedConnectors: parsed.data.connectors,
              submittedUrls: parsed.data.submittedUrls,
            })
            return { kind: 'created' as const, job, acceptedConnectors, blockedConnectors }
          })

          if (result.kind === 'not_found') return Response.json({ error: 'Builder not tracked' }, { status: 404 })
          if (result.kind === 'restricted') return Response.json({ error: 'processing_restricted' }, { status: 409 })
          if (result.kind === 'existing') {
            return Response.json({ jobId: result.job.id, status: result.job.status }, { status: 200 })
          }
          return Response.json({
            jobId: result.job.id,
            status: 'queued',
            acceptedConnectors: result.acceptedConnectors,
            blockedConnectors: result.blockedConnectors,
          }, { status: 202 })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('evidence-refresh error:', error)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
