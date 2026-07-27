/**
 * Wave 1 Task 2 — privacy/GDPR state fixtures.
 *
 * Consent records, data-export requests, and deletion requests are seeded
 * directly: the privacy suites (Wave on privacy E2E) need to START from
 * these states, not re-drive the product flows that create them each time.
 * Timestamps always come from the fixed E2E clock.
 */
import type { Sql } from 'postgres'
import { uniqueId } from '../ids'

export type ConsentDocument = 'tos' | 'privacy' | 'cookies'
export type DataExportStatus = 'pending' | 'ready' | 'failed' | 'expired'
export type DeletionRequestStatus = 'pending' | 'completed' | 'cancelled'

export async function seedConsent(
  sql: Sql,
  input: { userId: string; document: ConsentDocument; version: string; acceptedAt: Date; scope?: string },
): Promise<{ id: string }> {
  const id = uniqueId('consent', input.scope)
  await sql`
    insert into user_consents (id, user_id, document, version, accepted_at)
    values (${id}, ${input.userId}, ${input.document}, ${input.version}, ${input.acceptedAt})
  `
  return { id }
}

export async function seedDataExportRequest(
  sql: Sql,
  input: { userId: string; status: DataExportStatus; expiresAt?: Date | null; scope?: string },
): Promise<{ id: string }> {
  const id = uniqueId('export', input.scope)
  await sql`
    insert into data_export_requests (id, user_id, status, expires_at)
    values (${id}, ${input.userId}, ${input.status}, ${input.expiresAt ?? null})
  `
  return { id }
}

/** `deletion_requests.user_id` is unique and FK-less by design (compliance record). */
export async function seedDeletionRequest(
  sql: Sql,
  input: { userId: string; gracePeriodEndsAt: Date; status?: DeletionRequestStatus; scope?: string },
): Promise<{ id: string }> {
  const id = uniqueId('deletion', input.scope)
  await sql`
    insert into deletion_requests (id, user_id, status, grace_period_ends_at)
    values (${id}, ${input.userId}, ${input.status ?? 'pending'}, ${input.gracePeriodEndsAt})
  `
  return { id }
}

/** Cleanup scoped to one user — consents/exports also cascade with the user row. */
export async function cleanupPrivacyForUser(sql: Sql, userId: string): Promise<void> {
  await sql`delete from user_consents where user_id = ${userId}`
  await sql`delete from data_export_requests where user_id = ${userId}`
  await sql`delete from deletion_requests where user_id = ${userId}`
}
