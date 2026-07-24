import { describe, expect, it } from 'vitest'
import { shouldBlockLegacyPlanMutations } from './platform-billing'

describe('shouldBlockLegacyPlanMutations', () => {
  it('blocks once the canonical Stripe billing system is live', () => {
    expect(shouldBlockLegacyPlanMutations('true')).toBe(true)
  })

  it('does not block while Stripe billing is disabled', () => {
    expect(shouldBlockLegacyPlanMutations('false')).toBe(false)
  })

  it('never blocks for anything other than the exact string "true" — a malformed or missing flag must fail open to the existing legacy behavior, not silently lock out self-service upgrades', () => {
    expect(shouldBlockLegacyPlanMutations('')).toBe(false)
    expect(shouldBlockLegacyPlanMutations('True')).toBe(false)
  })
})
