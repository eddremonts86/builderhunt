/**
 * Wave 1 Task 2 — background-worker (enrichment job) fixtures.
 *
 * The workers/replay suites need jobs in known states without racing the
 * real queue, so fixtures seed `enrichment_jobs` directly. The composite FK
 * requires the (organization, builder identity) pair to already be tracked —
 * seed via `fixtures/builders.ts` first. `available_at` and lease timestamps
 * derive from the fixed E2E clock.
 */
import type { Sql } from 'postgres'
import { uniqueId } from '../ids'

export type EnrichmentJobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type EnrichmentJobTrigger = 'manual' | 'scheduled'

export async function seedEnrichmentJob(
  sql: Sql,
  input: {
    organizationId: string
    builderIdentityId: string
    requestedByUserId?: string | null
    status?: EnrichmentJobStatus
    trigger?: EnrichmentJobTrigger
    availableAt: Date
    leaseToken?: string | null
    leaseExpiresAt?: Date | null
    scope?: string
  },
): Promise<{ jobId: string }> {
  const jobId = uniqueId('enrichment-job', input.scope)
  await sql`
    insert into enrichment_jobs
      (id, organization_id, builder_identity_id, requested_by_user_id, trigger, status,
       available_at, lease_token, lease_expires_at)
    values
      (${jobId}, ${input.organizationId}, ${input.builderIdentityId},
       ${input.requestedByUserId ?? null}, ${input.trigger ?? 'manual'}, ${input.status ?? 'queued'},
       ${input.availableAt}, ${input.leaseToken ?? null}, ${input.leaseExpiresAt ?? null})
  `
  return { jobId }
}

export async function cleanupEnrichmentJob(sql: Sql, jobId: string): Promise<void> {
  await sql`delete from enrichment_jobs where id = ${jobId}`
}
