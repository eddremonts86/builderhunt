import { and, eq, sql } from 'drizzle-orm'
import { platformDb } from '../db/client'
import { workerDb } from '../db/worker-db'
import { builderProcessingRestrictions } from '../db/schema'

export type RestrictionReason = 'subject_request' | 'legal' | 'safety'

/**
 * Platform-scoped table (spec §7.3) — one row per builder identity, no
 * organization_id. Written only through this repository (builderhunt_platform
 * role); app/worker check the effective boolean via the
 * `is_builder_processing_restricted` SQL function instead of reading this
 * table directly (see enrichment.ts / enrichment-worker.ts).
 */
export async function activateBuilderProcessingRestriction(input: {
  builderIdentityId: string
  reason: RestrictionReason
  actorUserId?: string | null
  reference?: string | null
}) {
  const existing = await platformDb.select().from(builderProcessingRestrictions)
    .where(and(
      eq(builderProcessingRestrictions.builderIdentityId, input.builderIdentityId),
      eq(builderProcessingRestrictions.status, 'active'),
    ))
    .limit(1)
  if (existing.length > 0) return existing[0]

  const [row] = await platformDb.insert(builderProcessingRestrictions).values({
    builderIdentityId: input.builderIdentityId,
    reason: input.reason,
    status: 'active',
    actorUserId: input.actorUserId ?? null,
    reference: input.reference ?? null,
  }).returning()
  return row
}

export async function findActiveBuilderProcessingRestriction(builderIdentityId: string) {
  const [row] = await platformDb.select().from(builderProcessingRestrictions)
    .where(and(
      eq(builderProcessingRestrictions.builderIdentityId, builderIdentityId),
      eq(builderProcessingRestrictions.status, 'active'),
    ))
    .limit(1)
  return row ?? null
}

export async function withdrawBuilderProcessingRestriction(builderIdentityId: string) {
  const [row] = await platformDb.update(builderProcessingRestrictions)
    .set({ status: 'withdrawn', withdrawnAt: new Date() })
    .where(and(
      eq(builderProcessingRestrictions.builderIdentityId, builderIdentityId),
      eq(builderProcessingRestrictions.status, 'active'),
    ))
    .returning()
  return row ?? null
}

export interface EnrichmentProvenanceEntry {
  source: string
  observedAt: string
  expiresAt: string
  retentionState: 'active' | 'expired'
}

/**
 * Cross-organization aggregation for the verified-claimant provenance read
 * (spec §5.5, §10). enrichment_evidence has no grant for builderhunt_platform
 * (spec §7.3: "no direct app-table mutation" for that role) — this uses the
 * worker connection instead, which already has the necessary cross-org
 * SELECT (drizzle/0017_enrichment_rls_policies.sql), for a read-only,
 * already-minimized projection with zero tenant/reviewer/score fields.
 */
export async function listEnrichmentProvenanceForIdentity(builderIdentityId: string): Promise<EnrichmentProvenanceEntry[]> {
  const rows = await workerDb.execute(sql`
    select connector, observed_at, expires_at
    from enrichment_evidence
    where builder_identity_id = ${builderIdentityId} and resolution in ('accepted', 'review')
    order by observed_at desc
  `) as unknown as Array<{ connector: string; observed_at: string; expires_at: string }>

  // `drizzle`'s raw `.execute()` returns timestamp columns as strings, not
  // `Date` (unlike the typed query builder, and unlike the underlying
  // `postgres` driver used directly) — always convert before calling any
  // Date method. Confirmed this route 500'd on every real call before this
  // fix (found while extending scripts/db/verify-api-isolation-local.mjs).
  return rows.map((row) => {
    const expiresAt = new Date(row.expires_at)
    return {
      source: row.connector,
      observedAt: new Date(row.observed_at).toISOString(),
      expiresAt: expiresAt.toISOString(),
      retentionState: expiresAt.getTime() > Date.now() ? 'active' : 'expired',
    }
  })
}
