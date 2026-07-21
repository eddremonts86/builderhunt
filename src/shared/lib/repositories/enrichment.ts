import { and, desc, eq, sql } from 'drizzle-orm'
import type { EnrichmentEvidencePayload, EnrichmentTarget } from '~/lib/enrichment/types'
import type { TenantTransaction } from '../db/client'
import { builderIdentities, enrichmentEvidence, enrichmentJobs, organizationBuilders } from '../db/schema'

export interface EnqueueEnrichmentJobInput {
  id: string
  organizationId: string
  builderIdentityId: string
  requestedByUserId: string | null
  trigger: 'manual' | 'scheduled'
  requestedConnectors: string[]
  submittedUrls: string[]
}

export interface EnrichmentJobRecord {
  id: string
  organizationId: string
  builderIdentityId: string
  trigger: string
  status: string
  requestedConnectors: string[]
  attemptCount: number
  lastErrorCode: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface EnrichmentEvidenceRecord {
  id: string
  builderIdentityId: string
  connector: string
  acquisitionMode: string
  sourceUrl: string
  payload: EnrichmentEvidencePayload
  confidenceBps: number
  matchSignals: string[]
  contradictions: string[]
  resolution: 'accepted' | 'review' | 'rejected'
  observedAt: string
  expiresAt: string
  reviewedByUserId: string | null
  reviewedAt: string | null
}

/**
 * Loads the connector target shape for a builder identity the organization
 * actually tracks. Returns null if the organization has not tracked this
 * identity — callers must treat that as "not found", never as "arbitrary
 * global identity allowed" (spec §7.1 FK rule).
 */
export async function findTrackedEnrichmentTarget(
  transaction: TenantTransaction,
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

export async function findActiveEnrichmentJob(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
): Promise<EnrichmentJobRecord | null> {
  const [row] = await transaction.select().from(enrichmentJobs)
    .where(and(
      eq(enrichmentJobs.organizationId, organizationId),
      eq(enrichmentJobs.builderIdentityId, builderIdentityId),
      sql`${enrichmentJobs.status} in ('queued', 'running')`,
    ))
    .limit(1)
  return row ? toJobRecord(row) : null
}

export async function enqueueEnrichmentJob(
  transaction: TenantTransaction,
  input: EnqueueEnrichmentJobInput,
): Promise<EnrichmentJobRecord> {
  const [row] = await transaction.insert(enrichmentJobs).values({
    id: input.id,
    organizationId: input.organizationId,
    builderIdentityId: input.builderIdentityId,
    requestedByUserId: input.requestedByUserId,
    trigger: input.trigger,
    status: 'queued',
    requestedConnectors: input.requestedConnectors,
    submittedUrls: input.submittedUrls,
  }).returning()
  return toJobRecord(row)
}

export async function findLatestEnrichmentJob(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
): Promise<EnrichmentJobRecord | null> {
  const [row] = await transaction.select().from(enrichmentJobs)
    .where(and(
      eq(enrichmentJobs.organizationId, organizationId),
      eq(enrichmentJobs.builderIdentityId, builderIdentityId),
    ))
    .orderBy(desc(enrichmentJobs.createdAt))
    .limit(1)
  return row ? toJobRecord(row) : null
}

export async function listEnrichmentEvidence(
  transaction: TenantTransaction,
  organizationId: string,
  builderIdentityId: string,
): Promise<EnrichmentEvidenceRecord[]> {
  const rows = await transaction.select().from(enrichmentEvidence)
    .where(and(
      eq(enrichmentEvidence.organizationId, organizationId),
      eq(enrichmentEvidence.builderIdentityId, builderIdentityId),
      sql`${enrichmentEvidence.resolution} in ('accepted', 'review')`,
      sql`${enrichmentEvidence.expiresAt} > now()`,
    ))
    .orderBy(desc(enrichmentEvidence.observedAt))
  return rows.map(toEvidenceRecord)
}

export async function findEnrichmentEvidence(
  transaction: TenantTransaction,
  organizationId: string,
  evidenceId: string,
): Promise<EnrichmentEvidenceRecord | null> {
  const [row] = await transaction.select().from(enrichmentEvidence)
    .where(and(eq(enrichmentEvidence.organizationId, organizationId), eq(enrichmentEvidence.id, evidenceId)))
    .limit(1)
  return row ? toEvidenceRecord(row) : null
}

export async function reviewEnrichmentEvidence(
  transaction: TenantTransaction,
  organizationId: string,
  evidenceId: string,
  input: { resolution: 'accepted' | 'rejected'; reviewerUserId: string },
): Promise<EnrichmentEvidenceRecord | null> {
  const [row] = await transaction.update(enrichmentEvidence)
    .set({ resolution: input.resolution, reviewedByUserId: input.reviewerUserId, reviewedAt: new Date() })
    .where(and(eq(enrichmentEvidence.organizationId, organizationId), eq(enrichmentEvidence.id, evidenceId)))
    .returning()
  return row ? toEvidenceRecord(row) : null
}

/**
 * Checks the platform-scoped subject restriction through a SECURITY DEFINER
 * SQL function (drizzle/0017_enrichment_rls_policies.sql) — the app/worker
 * roles never read builder_processing_restrictions rows directly (spec §7.3).
 */
export async function isBuilderProcessingRestricted(
  transaction: TenantTransaction,
  builderIdentityId: string,
): Promise<boolean> {
  const [row] = await transaction.execute(
    sql`select is_builder_processing_restricted(${builderIdentityId}) as restricted`,
  ) as unknown as Array<{ restricted: boolean }>
  return Boolean(row?.restricted)
}

/** Used by account/organization export (Phase 5). */
export async function listEnrichmentEvidenceForExport(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<EnrichmentEvidenceRecord[]> {
  const rows = await transaction.select().from(enrichmentEvidence)
    .where(eq(enrichmentEvidence.organizationId, organizationId))
  return rows.map(toEvidenceRecord)
}

/** Used by account/organization deletion (Phase 5). Deletes this org's rows only. */
export async function deleteOrganizationEnrichmentData(
  transaction: TenantTransaction,
  organizationId: string,
): Promise<void> {
  await transaction.delete(enrichmentEvidence).where(eq(enrichmentEvidence.organizationId, organizationId))
  await transaction.delete(enrichmentJobs).where(eq(enrichmentJobs.organizationId, organizationId))
}

function toJobRecord(row: typeof enrichmentJobs.$inferSelect): EnrichmentJobRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    builderIdentityId: row.builderIdentityId,
    trigger: row.trigger,
    status: row.status,
    requestedConnectors: row.requestedConnectors,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toEvidenceRecord(row: typeof enrichmentEvidence.$inferSelect): EnrichmentEvidenceRecord {
  return {
    id: row.id,
    builderIdentityId: row.builderIdentityId,
    connector: row.connector,
    acquisitionMode: row.acquisitionMode,
    sourceUrl: row.sourceUrl,
    payload: row.payload,
    confidenceBps: row.confidenceBps,
    matchSignals: row.matchSignals,
    contradictions: row.contradictions,
    resolution: row.resolution as 'accepted' | 'review' | 'rejected',
    observedAt: row.observedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  }
}
