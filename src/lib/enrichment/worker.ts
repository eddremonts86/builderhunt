/**
 * Public Profile Enrichment — worker orchestration.
 * Spec reference: plans/stealth-scraping/spec.md §11. Sequential connectors
 * per job, bounded concurrency of two jobs, deterministic retry schedule.
 */

import { env } from '~/shared/lib/env'
import { log } from '~/shared/lib/log'
import {
  cancelActiveEnrichmentJobsForIdentity,
  claimDueEnrichmentJobs,
  finishEnrichmentJob,
  isBuilderProcessingRestrictedForWorker,
  loadWorkerEnrichmentTarget,
  persistEnrichmentEvidence,
  purgeEnrichmentEvidenceForIdentity,
  reclaimExpiredEnrichmentLeases,
  requeueEnrichmentJob,
  runEnrichmentRetentionPass,
  withWorkerOrganization,
  type ClaimedEnrichmentJob,
} from '~/shared/lib/repositories/enrichment-worker'
import { computeEvidenceContentHash } from './hash'
import { getExecutableConnectors } from './registry'
import { resolveEnrichmentCandidate } from './resolver'

/** Deterministic exponential backoff for rate_limited/upstream_unavailable retries (spec §11.8). */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]

export interface EnrichmentWorkerResult {
  disabled: boolean
  claimed: number
  processed: number
  succeeded: number
  partial: number
  failed: number
  leasesReclaimed: number
  evidenceAccepted: number
  evidenceReview: number
  retentionEvidenceDeleted: number
  retentionJobsDeleted: number
}

export async function runEnrichmentWorker(): Promise<EnrichmentWorkerResult> {
  if (env.ENRICHMENT_ENABLED !== 'true') {
    return {
      disabled: true,
      claimed: 0,
      processed: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      leasesReclaimed: 0,
      evidenceAccepted: 0,
      evidenceReview: 0,
      retentionEvidenceDeleted: 0,
      retentionJobsDeleted: 0,
    }
  }

  const leasesReclaimed = await reclaimExpiredEnrichmentLeases(env.ENRICHMENT_BATCH_SIZE)
  const claimedJobs = await claimDueEnrichmentJobs(env.ENRICHMENT_BATCH_SIZE, env.ENRICHMENT_LEASE_SECONDS)
  log.info('enrichment_worker_run', { claimed: claimedJobs.length, leasesReclaimed })

  const result: EnrichmentWorkerResult = {
    disabled: false,
    claimed: claimedJobs.length,
    processed: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    leasesReclaimed,
    evidenceAccepted: 0,
    evidenceReview: 0,
    retentionEvidenceDeleted: 0,
    retentionJobsDeleted: 0,
  }

  const CONCURRENCY = 2
  for (let i = 0; i < claimedJobs.length; i += CONCURRENCY) {
    const batch = claimedJobs.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async (job) => {
      await processEnrichmentJob(job, result)
      result.processed++
    }))
  }

  const retention = await runEnrichmentRetentionPass({
    rawRetentionDays: env.ENRICHMENT_RAW_RETENTION_DAYS,
    acceptedRetentionDays: env.ENRICHMENT_ACCEPTED_RETENTION_DAYS,
    batchSize: 500,
  })
  result.retentionEvidenceDeleted = retention.evidenceDeleted
  result.retentionJobsDeleted = retention.jobsDeleted
  log.info('enrichment_retention_run', retention)

  return result
}

async function processEnrichmentJob(job: ClaimedEnrichmentJob, result: EnrichmentWorkerResult): Promise<void> {
  if (await isBuilderProcessingRestrictedForWorker(job.builderIdentityId)) {
    await withWorkerOrganization(job.organizationId, (tx) =>
      finishEnrichmentJob(tx, job.id, { status: 'cancelled', lastErrorCode: 'processing_restricted' }))
    result.failed++
    return
  }

  const connectors = getExecutableConnectors(env.ENRICHMENT_ALLOWED_CONNECTORS, job.requestedConnectors)
  if (connectors.length === 0 && job.submittedUrls.length === 0) {
    await withWorkerOrganization(job.organizationId, (tx) =>
      finishEnrichmentJob(tx, job.id, { status: 'failed', lastErrorCode: 'policy_denied' }))
    result.failed++
    return
  }

  const outcome = await withWorkerOrganization(job.organizationId, async (tx) => {
    const target = await loadWorkerEnrichmentTarget(tx, job.organizationId, job.builderIdentityId)
    if (!target) return { status: 'failed' as const, code: 'target_not_found' }
    const fullTarget = { ...target, submittedUrls: job.submittedUrls }

    let acceptedOrReview = 0
    let anyConnectorFailed = false
    let retryCode: 'rate_limited' | 'upstream_unavailable' | null = null
    let retryAt: Date | null = null

    for (const connector of connectors) {
      if (!connector.supports(fullTarget)) continue
      const controller = new AbortController()
      let outcomeForConnector
      try {
        outcomeForConnector = await connector.collect(fullTarget, controller.signal)
      } catch (error) {
        anyConnectorFailed = true
        log.error('enrichment_connector_result', { connector: connector.id, jobId: job.id, error: error instanceof Error ? error.message : 'unknown' })
        continue
      }
      log.info('enrichment_connector_result', { connector: connector.id, jobId: job.id, kind: outcomeForConnector.kind })

      if (outcomeForConnector.kind === 'evidence') {
        for (const candidate of outcomeForConnector.candidates) {
          const resolved = resolveEnrichmentCandidate({ target: fullTarget, candidate: candidate.payload })
          const contentHash = computeEvidenceContentHash({
            connector: candidate.connector,
            sourceRecordId: candidate.sourceRecordId,
            payload: candidate.payload,
          })
          const expiresAt = new Date(Date.now() + (resolved.resolution === 'accepted'
            ? env.ENRICHMENT_ACCEPTED_RETENTION_DAYS
            : env.ENRICHMENT_RAW_RETENTION_DAYS) * 24 * 60 * 60_000)
          const persisted = await persistEnrichmentEvidence(tx, job.organizationId, {
            jobId: job.id,
            builderIdentityId: job.builderIdentityId,
            connector: candidate.connector,
            acquisitionMode: candidate.acquisitionMode,
            sourceUrl: candidate.sourceUrl,
            sourceRecordId: candidate.sourceRecordId,
            contentHash,
            payload: candidate.payload,
            confidenceBps: resolved.confidenceBps,
            resolverVersion: resolved.resolverVersion,
            scoreComponents: resolved.scoreComponents,
            matchSignals: resolved.matchSignals,
            contradictions: resolved.contradictions,
            resolution: resolved.resolution,
            observedAt: candidate.observedAt,
            expiresAt,
          })
          if (persisted && resolved.resolution !== 'rejected') {
            acceptedOrReview++
            if (resolved.resolution === 'accepted') result.evidenceAccepted++
            else result.evidenceReview++
          }
        }
      } else if (outcomeForConnector.kind === 'retry') {
        anyConnectorFailed = true
        retryCode = outcomeForConnector.code
        retryAt = outcomeForConnector.retryAt
      } else if (outcomeForConnector.kind === 'stop') {
        anyConnectorFailed = true
      }
    }

    if (retryCode && job.attemptCount < env.ENRICHMENT_MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[Math.min(job.attemptCount - 1, RETRY_DELAYS_MS.length - 1)]
      return { status: 'retry' as const, code: retryCode, availableAt: retryAt ?? new Date(Date.now() + delay) }
    }
    if (acceptedOrReview > 0 && anyConnectorFailed) return { status: 'partial' as const }
    if (acceptedOrReview > 0) return { status: 'succeeded' as const }
    return { status: 'failed' as const, code: anyConnectorFailed ? 'all_connectors_failed' : 'no_data' }
  })

  await withWorkerOrganization(job.organizationId, async (tx) => {
    if (outcome.status === 'retry') {
      await requeueEnrichmentJob(tx, job.id, { availableAt: outcome.availableAt, lastErrorCode: outcome.code })
      return
    }
    await finishEnrichmentJob(tx, job.id, { status: outcome.status, lastErrorCode: 'code' in outcome ? outcome.code ?? null : null })
  })

  if (outcome.status === 'succeeded') result.succeeded++
  else if (outcome.status === 'partial') result.partial++
  else if (outcome.status === 'failed') result.failed++
}

/** Subject-restriction cascade entry point (spec §5.5, §10) — not tenant-scoped, acts across every organization. */
export async function cascadeBuilderProcessingRestriction(builderIdentityId: string): Promise<{ jobsCancelled: number; evidencePurged: number }> {
  const jobsCancelled = await cancelActiveEnrichmentJobsForIdentity(builderIdentityId)
  const evidencePurged = await purgeEnrichmentEvidenceForIdentity(builderIdentityId)
  log.info('enrichment_subject_restriction', { builderIdentityId, jobsCancelled, evidencePurged })
  return { jobsCancelled, evidencePurged }
}
