/**
 * Public Profile Enrichment — canonical content hash for evidence dedup.
 * Spec reference: plans/phase-1/41-stealth-scraping/spec.md §7.2, §9. Hashes only
 * minimized evidence — never raw upstream response material.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from '~/shared/lib/ai/cache'
import type { EnrichmentEvidencePayload } from './types'

export function computeEvidenceContentHash(input: {
  connector: string
  sourceRecordId?: string | null
  payload: EnrichmentEvidencePayload
}): string {
  const canonical = canonicalJson({
    connector: input.connector,
    sourceRecordId: input.sourceRecordId ?? null,
    payload: input.payload,
  })
  return createHash('sha256').update(canonical).digest('hex')
}
