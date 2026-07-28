/**
 * Fixtures, not a seeded month of traffic. Every band this module defines is a arithmetic decision about
 * someone's bill, and the ones that matter most are the two it refuses to act on: an under-billing, which must
 * never be chased into a closed period, and a rounding difference, which must never be reported as a
 * discrepancy or every interview becomes one.
 */
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ refundUsage: vi.fn() }))
vi.mock('~/shared/lib/billing/feature-authorization', () => ({ refundUsage: mocks.refundUsage }))

const {
  classifyUsage,
  normalizeProviderUsage,
  reconcileInterviewUsage,
  toReconciliationMismatchType,
  USAGE_VARIANCE_POLICY_FRACTION,
} = await import('~/lib/interviews/usage-reconciliation')

const NOW = new Date('2028-03-01T09:00:00.000Z')

const settlement = (overrides: Record<string, unknown> = {}) => ({
  reservationId: 'res-1',
  operation: 'interview_live_transcription',
  providerReference: 'req-1',
  settledUnits: 31,
  settledAt: NOW,
  ...overrides,
} as never)

const providerRecord = (overrides: Record<string, unknown> = {}) => ({
  providerReference: 'req-1',
  billedSeconds: 1_860,
  occurredAt: NOW,
  ...overrides,
} as never)

describe('normalizing a provider figure', () => {
  it('rounds transcription seconds up to whole minutes, like the rate card', () => {
    // Using a different rounding here would manufacture a variance on every single interview.
    expect(normalizeProviderUsage(providerRecord({ billedSeconds: 1_860 }), 'interview_live_transcription').units).toBe(31)
    expect(normalizeProviderUsage(providerRecord({ billedSeconds: 61 }), 'interview_live_transcription').units).toBe(2)
    expect(normalizeProviderUsage(providerRecord({ billedSeconds: 0 }), 'interview_live_transcription').units).toBe(0)
  })

  it('prices a text task flat and carries tokens as evidence only', () => {
    const result = normalizeProviderUsage(
      providerRecord({ billedSeconds: undefined, promptTokens: 9_000, completionTokens: 2_000 }),
      'interview_final_report',
    )
    // The rate card charges 5 for a report regardless of size, so a token count is a fact about the call, not
    // a quantity to bill.
    expect(result).toEqual({ units: 5, basis: 'tokens' })
  })
})

describe('the bands', () => {
  it('calls an exact match matched', () => {
    const result = classifyUsage({ settlement: settlement(), provider: providerRecord() })
    expect(result.outcome).toBe('matched')
    expect(result.differenceUnits).toBe(0)
  })

  it('calls a one-unit seconds difference rounding, not a variance', () => {
    // 1,801 seconds is 30.02 minutes; the rate card charges 31. Reporting that would make every interview a
    // discrepancy and the whole report worthless.
    const result = classifyUsage({
      settlement: settlement({ settledUnits: 31 }),
      provider: providerRecord({ billedSeconds: 1_800 }),
    })
    expect(result.outcome).toBe('rounding')
  })

  it('calls a small real difference a variance within policy', () => {
    // 200 provider units against 202 settled: exactly 1%, which is the boundary and not above it. Needs a
    // difference of at least two units, because one is inside the rounding band by design — a first version of
    // this test used 100 against 101 and was measuring rounding while claiming to measure variance.
    const result = classifyUsage({
      settlement: settlement({ settledUnits: 202 }),
      provider: providerRecord({ billedSeconds: 12_000 }),
    })
    expect(result.outcome).toBe('variance_within_policy')
  })

  it('escalates a difference above policy', () => {
    const result = classifyUsage({
      settlement: settlement({ settledUnits: 120 }),
      provider: providerRecord({ billedSeconds: 6_000 }),
    })
    expect(result.outcome).toBe('variance_above_policy')
    expect(result.differenceUnits).toBe(20)
    expect(result.detail).toMatch(/20\.00% over/)
  })

  it('uses one percent as the boundary', () => {
    expect(USAGE_VARIANCE_POLICY_FRACTION).toBe(0.01)
  })

  it('reports a settled reservation with no provider record', () => {
    const result = classifyUsage({ settlement: settlement(), provider: null })
    expect(result.outcome).toBe('missing_provider')
    expect(result.detail).toMatch(/late export/)
  })

  it('does not alarm on a release with no provider record', () => {
    // Nothing was transcribed and nothing was billed. That is the expected pair, not a discrepancy.
    const result = classifyUsage({ settlement: settlement({ settledUnits: 0 }), provider: null })
    expect(result.outcome).toBe('missing_provider')
    expect(result.detail).toMatch(/expected pair/)
  })

  it('reports provider work the platform never settled', () => {
    const result = classifyUsage({
      settlement: settlement({ settledUnits: 0 }),
      provider: providerRecord({ billedSeconds: 1_800 }),
    })
    // A metering failure, not an arithmetic one: the hold was released and the provider billed anyway.
    expect(result.outcome).toBe('missing_settlement')
    expect(result.differenceUnits).toBe(-30)
  })

  it('refuses to reconcile a duplicated provider reference', () => {
    const result = classifyUsage({
      settlement: settlement(),
      provider: providerRecord(),
      duplicateProviderReferences: new Set(['req-1']),
    })
    expect(result.outcome).toBe('duplicate_provider')
    // Not summed: two records for one reference could be a retry or a double-report, and adding them would
    // bill a customer for the provider's own ambiguity.
    expect(result.providerUnits).toBe(0)
  })
})

describe('a full reconciliation', () => {
  const run = (overrides: Record<string, unknown> = {}) => reconcileInterviewUsage({
    settlements: [settlement()],
    providerRecords: [providerRecord()],
    ...overrides,
  } as never)

  it('counts every outcome', async () => {
    const result = await run({
      settlements: [
        settlement({ reservationId: 'a', providerReference: 'req-a' }),
        settlement({ reservationId: 'b', providerReference: 'req-b', settledUnits: 120 }),
        settlement({ reservationId: 'c', providerReference: 'req-missing' }),
      ],
      providerRecords: [
        providerRecord({ providerReference: 'req-a' }),
        providerRecord({ providerReference: 'req-b', billedSeconds: 6_000 }),
      ],
    })
    expect(result.counts.matched).toBe(1)
    expect(result.counts.variance_above_policy).toBe(1)
    expect(result.counts.missing_provider).toBe(1)
  })

  it('lists provider records with no settlement at all', async () => {
    const result = await run({
      settlements: [settlement()],
      providerRecords: [providerRecord(), providerRecord({ providerReference: 'req-orphan' })],
    })
    expect(result.unmatchedProviderReferences).toEqual(['req-orphan'])
  })

  it('detects a duplicate across the export', async () => {
    const result = await run({
      settlements: [settlement()],
      providerRecords: [providerRecord(), providerRecord()],
    })
    expect(result.counts.duplicate_provider).toBe(1)
  })

  it('requests no refund on a report-only run', async () => {
    mocks.refundUsage.mockClear()
    await run({
      settlements: [settlement({ settledUnits: 120 })],
      providerRecords: [providerRecord({ billedSeconds: 6_000 })],
    })
    expect(mocks.refundUsage).not.toHaveBeenCalled()
  })
})

describe('refunds', () => {
  const withRefund = (settlements: unknown[], providerRecords: unknown[]) => reconcileInterviewUsage({
    settlements, providerRecords,
    refund: {
      transaction: {} as never,
      principal: { organizationId: 'org', userId: 'u', role: 'owner', requestId: 'r' } as never,
      settlementIdFor: (reservationId: string) => `settlement-${reservationId}`,
    },
  } as never)

  it('refunds an over-billing above policy, through the platform contract', async () => {
    mocks.refundUsage.mockClear().mockResolvedValue({})
    const result = await withRefund(
      [settlement({ settledUnits: 120 })],
      [providerRecord({ billedSeconds: 6_000 })],
    )
    expect(result.refundsRequested).toEqual([{ reservationId: 'res-1', units: 20 }])
    const [, , input] = mocks.refundUsage.mock.calls[0]
    expect(input).toMatchObject({
      settlementId: 'settlement-res-1',
      units: 20,
      reason: 'provider_usage_variance',
      // The platform refuses a usage refund on our say-so alone; the provider's reference is the evidence.
      providerEvidenceReference: 'req-1',
    })
    // Deterministic, so a re-run replays instead of refunding twice.
    expect(String(input.idempotencyKey)).toContain('res-1')
  })

  it('never chases an under-billing', async () => {
    mocks.refundUsage.mockClear().mockResolvedValue({})
    const result = await withRefund(
      [settlement({ settledUnits: 80 })],
      [providerRecord({ billedSeconds: 6_000 })],
    )
    // Above policy, but in the customer's favour. They have been told what the interview cost, and reaching
    // into a closed period to take more is not a correction.
    expect(result.comparisons[0].outcome).toBe('variance_above_policy')
    expect(result.refundsRequested).toEqual([])
    expect(mocks.refundUsage).not.toHaveBeenCalled()
  })

  it('does not refund a within-policy variance', async () => {
    mocks.refundUsage.mockClear().mockResolvedValue({})
    await withRefund([settlement({ settledUnits: 202 })], [providerRecord({ billedSeconds: 12_000 })])
    expect(mocks.refundUsage).not.toHaveBeenCalled()
  })

  it('does not refund rounding', async () => {
    mocks.refundUsage.mockClear().mockResolvedValue({})
    await withRefund([settlement({ settledUnits: 31 })], [providerRecord({ billedSeconds: 1_800 })])
    expect(mocks.refundUsage).not.toHaveBeenCalled()
  })

  it('skips a comparison whose settlement id cannot be resolved', async () => {
    mocks.refundUsage.mockClear().mockResolvedValue({})
    const result = await reconcileInterviewUsage({
      settlements: [settlement({ settledUnits: 120 })],
      providerRecords: [providerRecord({ billedSeconds: 6_000 })],
      refund: {
        transaction: {} as never,
        principal: {} as never,
        // A settlement the platform cannot identify must not be refunded on a guess.
        settlementIdFor: () => null,
      },
    } as never)
    expect(result.refundsRequested).toEqual([])
    expect(mocks.refundUsage).not.toHaveBeenCalled()
  })
})

describe('reporting through the platform contract', () => {
  it('maps each actionable outcome onto an existing mismatch type', () => {
    expect(toReconciliationMismatchType('missing_settlement')).toBe('missing_internal')
    expect(toReconciliationMismatchType('missing_provider')).toBe('extra_internal')
    expect(toReconciliationMismatchType('variance_above_policy')).toBe('stale_internal')
    expect(toReconciliationMismatchType('duplicate_provider')).toBe('duplicate_provider_listing')
  })

  it('reports neither a match nor rounding as a mismatch', () => {
    // Reporting them would bury the ones that are.
    expect(toReconciliationMismatchType('matched')).toBeNull()
    expect(toReconciliationMismatchType('rounding')).toBeNull()
    expect(toReconciliationMismatchType('variance_within_policy')).toBeNull()
  })
})

describe('late provider reports', () => {
  it('are missing_provider on the first run and matched on the next', async () => {
    // The export arrived after the settlement closed, which is the ordinary case for a provider that batches.
    const first = await reconcileInterviewUsage({ settlements: [settlement()], providerRecords: [] } as never)
    expect(first.counts.missing_provider).toBe(1)

    const second = await reconcileInterviewUsage({
      settlements: [settlement()], providerRecords: [providerRecord()],
    } as never)
    expect(second.counts.matched).toBe(1)
  })
})
