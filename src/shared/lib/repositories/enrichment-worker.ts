import { and, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { EnrichmentEvidencePayload, EnrichmentTarget } from '~/lib/enrichment/types'
import { withWorkerOrganization } from './alerts-worker'
import { enrichmentEvidence, enrichmentJobs, builderIdentities, organizationBuilders } from '../db/schema'
import { workerDb, type WorkerTransaction } from '../db/worker-db'

export interface ClaimedEnrichmentJob {
  id: string
  organizationId: string
  builderIdentityId: string
  requestedConnectors: string[]
  submittedUrls: string[]
  attemptCount: number
  leaseToken: string
}

/**
 * Selects due jobs across every organization with `FOR UPDATE SKIP LOCKED`
 * and atomically marks them `running` with a fresh lease, all in one
 * transaction so the row lock never has to survive a transaction boundary.
 * Spec §11 steps 1–2.
 */
export async function claimDueEnrichmentJobs(
  limit: number,
  leaseSeconds: number,
  options: { db?: PostgresJsDatabase } = {},
): Promise<ClaimedEnrichmentJob[]> {
  const db = options.db ?? workerDb
  return db.transaction(async (tx) => {
    const due = await tx.execute(sql`
      select id, organization_id, builder_identity_id, requested_connectors, submitted_urls, attempt_count
      from enrichment_jobs
      where status = 'queued' and available_at <= now()
      order by available_at asc
      limit ${limit}
      for update skip locked
    `) as unknown as Array<{
      id: string
      organization_id: string
      builder_identity_id: string
      requested_connectors: string[]
      submitted_urls: string[]
      attempt_count: number
    }>

    const claimed: ClaimedEnrichmentJob[] = []
    for (const row of due) {
      const leaseToken = crypto.randomUUID()
      await tx.execute(sql`
        update enrichment_jobs
        set status = 'running',
            lease_token = ${leaseToken},
            lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
            attempt_count = attempt_count + 1,
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = ${row.id}
      `)
      claimed.push({
        id: row.id,
        organizationId: row.organization_id,
        builderIdentityId: row.builder_identity_id,
        requestedConnectors: row.requested_connectors,
        submittedUrls: row.submitted_urls,
        attemptCount: row.attempt_count + 1,
        leaseToken,
      })
    }
    return claimed
  })
}

/** Reclaims a job whose lease expired without the worker finishing it. */
export async function reclaimExpiredEnrichmentLeases(limit: number): Promise<number> {
  const result = await workerDb.execute(sql`
    update enrichment_jobs
    set status = 'queued', lease_token = null, lease_expires_at = null, updated_at = now()
    where status = 'running' and lease_expires_at < now()
    and id in (select id from enrichment_jobs where status = 'running' and lease_expires_at < now() limit ${limit})
  `) as unknown as { count?: number }
  return result?.count ?? 0
}

export async function loadWorkerEnrichmentTarget(
  transaction: WorkerTransaction,
  organizationId: string,
  builderIdentityId: string,
): Promise<EnrichmentTarget | null> {
  const [row] = await transaction
    .select({
      identityId: builderIdentities.id,
      source: builderIdentities.source,
      sourceId: builderIdentities.sourceId,
      username: builderIdentities.username,
      displayName: builderIdentities.displayName,
      profileUrl: builderIdentities.profileUrl,
      country: builderIdentities.country,
    })
    .from(organizationBuilders)
    .innerJoin(builderIdentities, eq(builderIdentities.id, organizationBuilders.builderIdentityId))
    .where(and(
      eq(organizationBuilders.organizationId, organizationId),
      eq(organizationBuilders.builderIdentityId, builderIdentityId),
    ))
    .limit(1)
  if (!row) return null
  return {
    builderIdentityId: row.identityId,
    source: row.source,
    sourceId: row.sourceId,
    username: row.username,
    displayName: row.displayName,
    profileUrl: row.profileUrl,
    knownOrganization: null,
    knownLocation: row.country,
    submittedUrls: [],
  }
}

export interface PersistEvidenceInput {
  id?: string
  jobId: string
  builderIdentityId: string
  connector: string
  acquisitionMode: string
  sourceUrl: string
  sourceRecordId?: string | null
  contentHash: string
  payload: EnrichmentEvidencePayload
  confidenceBps: number
  resolverVersion: number
  scoreComponents: Record<string, number>
  matchSignals: string[]
  contradictions: string[]
  resolution: 'accepted' | 'review' | 'rejected'
  observedAt: Date
  expiresAt: Date
}

/** Upsert-by-content-hash: double execution creates zero duplicate rows (spec §11). */
export async function persistEnrichmentEvidence(
  transaction: WorkerTransaction,
  organizationId: string,
  input: PersistEvidenceInput,
) {
  const [row] = await transaction.insert(enrichmentEvidence).values({
    organizationId,
    jobId: input.jobId,
    builderIdentityId: input.builderIdentityId,
    connector: input.connector,
    acquisitionMode: input.acquisitionMode,
    sourceUrl: input.sourceUrl,
    sourceRecordId: input.sourceRecordId ?? null,
    contentHash: input.contentHash,
    payload: input.payload,
    confidenceBps: input.confidenceBps,
    resolverVersion: input.resolverVersion,
    scoreComponents: input.scoreComponents,
    matchSignals: input.matchSignals,
    contradictions: input.contradictions,
    resolution: input.resolution,
    observedAt: input.observedAt,
    expiresAt: input.expiresAt,
  })
    .onConflictDoNothing({
      target: [enrichmentEvidence.organizationId, enrichmentEvidence.builderIdentityId, enrichmentEvidence.connector, enrichmentEvidence.contentHash],
    })
    .returning()
  return row ?? null
}

export type EnrichmentJobTerminalStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled'

export async function finishEnrichmentJob(
  transaction: WorkerTransaction,
  jobId: string,
  input: { status: EnrichmentJobTerminalStatus; lastErrorCode?: string | null },
) {
  await transaction.update(enrichmentJobs).set({
    status: input.status,
    lastErrorCode: input.lastErrorCode ?? null,
    finishedAt: new Date(),
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(eq(enrichmentJobs.id, jobId))
}

export async function requeueEnrichmentJob(
  transaction: WorkerTransaction,
  jobId: string,
  input: { availableAt: Date; lastErrorCode: string },
) {
  await transaction.update(enrichmentJobs).set({
    status: 'queued',
    availableAt: input.availableAt,
    lastErrorCode: input.lastErrorCode,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  }).where(eq(enrichmentJobs.id, jobId))
}

/** Cross-org cascade for the subject-restriction flow (spec §5.5, §10). */
export async function cancelActiveEnrichmentJobsForIdentity(builderIdentityId: string): Promise<number> {
  const rows = await workerDb.execute(sql`
    update enrichment_jobs
    set status = 'cancelled', finished_at = now(), lease_token = null, lease_expires_at = null, updated_at = now()
    where builder_identity_id = ${builderIdentityId} and status in ('queued', 'running')
    returning id
  `) as unknown as Array<{ id: string }>
  return rows.length
}

/** Bounded purge of an identity's evidence across every organization (subject restriction). */
export async function purgeEnrichmentEvidenceForIdentity(builderIdentityId: string, batchSize = 500): Promise<number> {
  const rows = await workerDb.execute(sql`
    delete from enrichment_evidence
    where id in (
      select id from enrichment_evidence where builder_identity_id = ${builderIdentityId} limit ${batchSize}
    )
    returning id
  `) as unknown as Array<{ id: string }>
  return rows.length
}

/** Bounded retention pass — spec §11 point 6, §17 SLO "retention backlog returns to zero within 24 hours". */
export async function runEnrichmentRetentionPass(input: {
  rawRetentionDays: number
  acceptedRetentionDays: number
  batchSize: number
}): Promise<{ evidenceDeleted: number; jobsDeleted: number }> {
  const expiredEvidence = await workerDb.execute(sql`
    delete from enrichment_evidence
    where id in (
      select id from enrichment_evidence
      where (resolution = 'review' and observed_at < now() - make_interval(days => ${input.rawRetentionDays}))
         or (resolution = 'rejected' and observed_at < now() - interval '7 days')
         or (resolution = 'accepted' and expires_at < now())
      limit ${input.batchSize}
    )
    returning id
  `) as unknown as Array<{ id: string }>

  const oldJobs = await workerDb.execute(sql`
    delete from enrichment_jobs
    where id in (
      select id from enrichment_jobs
      where status in ('succeeded', 'partial', 'failed', 'cancelled')
        and finished_at < now() - interval '90 days'
      limit ${input.batchSize}
    )
    returning id
  `) as unknown as Array<{ id: string }>

  return { evidenceDeleted: expiredEvidence.length, jobsDeleted: oldJobs.length }
}

/**
 * Checks the platform-scoped subject restriction from worker context, via
 * the same SECURITY DEFINER function the tenant repository uses (spec §7.3).
 */
export async function isBuilderProcessingRestrictedForWorker(builderIdentityId: string): Promise<boolean> {
  const [row] = await workerDb.execute(
    sql`select is_builder_processing_restricted(${builderIdentityId}) as restricted`,
  ) as unknown as Array<{ restricted: boolean }>
  return Boolean(row?.restricted)
}

export { withWorkerOrganization }
