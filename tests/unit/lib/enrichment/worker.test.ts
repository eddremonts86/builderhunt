import { describe, expect, it } from 'vitest'
import { env } from '~/shared/lib/env'
import { runEnrichmentWorker } from '~/lib/enrichment/worker'

describe('runEnrichmentWorker — disabled mode (spec §12 kill switch)', () => {
  it('the test environment boots with enrichment disabled by default', () => {
    // Sanity check the precondition this suite relies on — if this ever
    // flips, the "no DB/network mutation" guarantee below stops being real.
    expect(env.ENRICHMENT_ENABLED).toBe('false')
  })

  it('returns the exact no-op shape and never touches the DB or network when disabled', async () => {
    const result = await runEnrichmentWorker()
    expect(result).toEqual({
      disabled: true,
      claimed: 0,
      processed: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      cancelled: 0,
      leasesReclaimed: 0,
      evidenceAccepted: 0,
      evidenceReview: 0,
      retentionEvidenceDeleted: 0,
      retentionJobsDeleted: 0,
    })
  })
})
