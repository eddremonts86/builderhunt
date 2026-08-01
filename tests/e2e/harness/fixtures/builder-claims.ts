/**
 * plans/UI/tasks.md Wave 4 "Add verified-subject provenance UI" / "Add restrict-processing
 * confirmation and state" — verified-claim and enrichment-evidence fixtures.
 *
 * `builder_claims` is never written by any UI flow this suite can drive locally (claim
 * verification goes through an external source-proof challenge), so a verified claim is seeded
 * directly, same rationale as `fixtures/workers.ts` for `enrichment_jobs`. `enrichment_evidence`'s
 * composite FK requires the (organization, builder identity) pair to already be tracked — seed via
 * `fixtures/builders.ts` first, then an `enrichment_jobs` row via `fixtures/workers.ts`.
 */
import type { Sql } from 'postgres'
import { uniqueId } from '../ids'

export async function seedVerifiedBuilderClaim(
  sql: Sql,
  input: { builderIdentityId: string; subjectUserId: string; scope?: string },
): Promise<{ claimId: string }> {
  const claimId = uniqueId('builder-claim', input.scope)
  await sql`
    insert into builder_claims (id, builder_identity_id, subject_user_id, evidence_source, evidence_reference, status, verified_at)
    values (${claimId}, ${input.builderIdentityId}, ${input.subjectUserId}, 'github', 'e2e-fixture', 'verified', now())
  `
  return { claimId }
}

export async function seedPublishedBuilderProfile(
  sql: Sql,
  input: { builderIdentityId: string; publishedByUserId: string; displayName?: string },
): Promise<void> {
  await sql`
    insert into published_builder_profiles (builder_identity_id, published_by_user_id, display_name)
    values (${input.builderIdentityId}, ${input.publishedByUserId}, ${input.displayName ?? 'E2E Claimant'})
    on conflict (builder_identity_id) do nothing
  `
}

export async function seedEnrichmentEvidence(
  sql: Sql,
  input: {
    organizationId: string
    jobId: string
    builderIdentityId: string
    connector?: string
    payload?: Record<string, string | string[]>
    resolution?: 'accepted' | 'review' | 'rejected'
    observedAt?: Date
    expiresAt: Date
    scope?: string
  },
): Promise<{ evidenceId: string }> {
  const connector = input.connector ?? 'github'
  const payload = input.payload ?? { profileUrl: 'https://e2e.test/github/example', headline: 'Ships distributed systems' }
  const contentHash = uniqueId('evidence-hash', input.scope)
  const [row] = await sql<{ id: string }[]>`
    insert into enrichment_evidence (
      organization_id, job_id, builder_identity_id, connector, acquisition_mode, source_url, content_hash,
      payload, confidence_bps, resolver_version, score_components, match_signals, contradictions,
      resolution, observed_at, expires_at
    )
    values (
      ${input.organizationId}, ${input.jobId}, ${input.builderIdentityId}, ${connector}, 'official_api',
      'https://e2e.test/source', ${contentHash}, ${sql.json(payload)}, 9000, 1, ${sql.json({})}, ${sql.json([])}, ${sql.json([])},
      ${input.resolution ?? 'accepted'}, ${input.observedAt ?? new Date()}, ${input.expiresAt}
    )
    returning id
  `
  return { evidenceId: row.id }
}

export async function cleanupBuilderClaim(sql: Sql, claimId: string): Promise<void> {
  await sql`delete from builder_claims where id = ${claimId}`
}

export async function cleanupPublishedBuilderProfile(sql: Sql, builderIdentityId: string): Promise<void> {
  await sql`delete from published_builder_profiles where builder_identity_id = ${builderIdentityId}`
}

export async function cleanupEnrichmentEvidence(sql: Sql, builderIdentityId: string): Promise<void> {
  await sql`delete from enrichment_evidence where builder_identity_id = ${builderIdentityId}`
}

export async function cleanupBuilderProcessingRestriction(sql: Sql, builderIdentityId: string): Promise<void> {
  await sql`delete from builder_processing_restrictions where builder_identity_id = ${builderIdentityId}`
}
