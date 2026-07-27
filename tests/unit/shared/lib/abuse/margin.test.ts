import { describe, expect, it, vi } from 'vitest'
import { checkMarginDriftAndEmit, detectMarginDrift, estimateProviderCostCents } from '~/shared/lib/abuse/margin'

describe('estimateProviderCostCents', () => {
  it('computes cost from prompt + completion tokens at the given per-1k rates', () => {
    const cost = estimateProviderCostCents({
      usage: { promptTokens: 1000, completionTokens: 500 },
      costPerThousandInputTokensCents: 0.03,
      costPerThousandOutputTokensCents: 0.12,
    })
    expect(cost).toBeCloseTo(0.03 + 0.06, 5) // 1000/1000*0.03 + 500/1000*0.12
  })

  it('returns 0 for zero usage', () => {
    const cost = estimateProviderCostCents({
      usage: { promptTokens: 0, completionTokens: 0 },
      costPerThousandInputTokensCents: 0.03,
      costPerThousandOutputTokensCents: 0.12,
    })
    expect(cost).toBe(0)
  })
})

describe('detectMarginDrift', () => {
  it('never flags when nothing was charged', () => {
    expect(detectMarginDrift({ providerCostCents: 10, creditsChargedCents: 0, ratioThreshold: 1 })).toBe(false)
    expect(detectMarginDrift({ providerCostCents: 10, creditsChargedCents: -5, ratioThreshold: 1 })).toBe(false)
  })

  it('does not flag when cost stays at or under the threshold ratio of what was charged', () => {
    expect(detectMarginDrift({ providerCostCents: 10, creditsChargedCents: 10, ratioThreshold: 1 })).toBe(false)
    expect(detectMarginDrift({ providerCostCents: 8, creditsChargedCents: 10, ratioThreshold: 1 })).toBe(false)
  })

  it('flags once cost exceeds the threshold ratio of what was charged', () => {
    expect(detectMarginDrift({ providerCostCents: 11, creditsChargedCents: 10, ratioThreshold: 1 })).toBe(true)
  })

  it('respects a looser threshold (tolerates some overrun before flagging)', () => {
    expect(detectMarginDrift({ providerCostCents: 11, creditsChargedCents: 10, ratioThreshold: 1.2 })).toBe(false)
    expect(detectMarginDrift({ providerCostCents: 13, creditsChargedCents: 10, ratioThreshold: 1.2 })).toBe(true)
  })
})

describe('checkMarginDriftAndEmit', () => {
  it('does not emit while cost stays within the ratio threshold', async () => {
    const insert = vi.fn()
    const flagged = await checkMarginDriftAndEmit(
      { providerCostCents: 8, creditsChargedCents: 10, ratioThreshold: 1, operation: 'ai_sourcing_sprint' },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('emits margin_drift with the computed ratio once cost crosses the threshold', async () => {
    const insert = vi.fn()
    const flagged = await checkMarginDriftAndEmit(
      { providerCostCents: 15, creditsChargedCents: 10, ratioThreshold: 1, operation: 'ai_sourcing_sprint' },
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'margin_drift',
      severity: 'medium',
      userId: 'user-1',
      organizationId: 'org-1',
      details: expect.objectContaining({
        operation: 'ai_sourcing_sprint',
        providerCostCents: 15,
        creditsChargedCents: 10,
        ratio: 1.5,
        ratioThreshold: 1,
      }),
    }))
  })
})
