import { describe, expect, it } from 'vitest'
import { applyBetaModeEntitlement } from '~/shared/lib/billing/effective-entitlement'
import type { EntitlementPolicy, EntitlementTier } from '~/shared/lib/repositories/entitlements'

/**
 * Plan 58's resolver, as a table.
 *
 * The whole point of `applyBetaModeEntitlement` being pure is that the policy — which fields beta mode
 * raises and which it must never touch — is checkable without a database. Its acceptance criteria are
 * mostly about what does *not* change.
 */
function policy(over: Partial<EntitlementPolicy> = {}): EntitlementPolicy {
  return {
    tier: 'free',
    status: 'active',
    active: true,
    paidActionsAllowed: false,
    seatLimit: 1,
    paymentBlocked: false,
    ...over,
  }
}

const TIERS: EntitlementTier[] = ['free', 'pro', 'pro_max', 'team']

describe('applyBetaModeEntitlement', () => {
  describe('with beta mode off', () => {
    it('changes nothing, for every tier', () => {
      for (const tier of TIERS) {
        const actual = policy({ tier })
        const effective = applyBetaModeEntitlement(actual, { enabled: false })
        expect(effective.tier).toBe(tier)
        expect(effective.actualTier).toBe(tier)
        expect(effective.betaModeActive).toBe(false)
        expect(effective.paidActionsAllowed).toBe(actual.paidActionsAllowed)
      }
    })
  })

  describe('with beta mode on', () => {
    it('raises free and pro to pro_max', () => {
      for (const tier of ['free', 'pro'] as const) {
        const effective = applyBetaModeEntitlement(policy({ tier }), { enabled: true })
        expect(effective.tier).toBe('pro_max')
        // The raw tier is still readable — a caller must always be able to tell the two apart.
        expect(effective.actualTier).toBe(tier)
        expect(effective.betaModeActive).toBe(true)
      }
    })

    it('leaves pro_max and team exactly where they are', () => {
      // A floor never lowers anything. Team is ranked equal to Pro Max for features, and downgrading it
      // was a defect in the superseded draft.
      for (const tier of ['pro_max', 'team'] as const) {
        const effective = applyBetaModeEntitlement(policy({ tier }), { enabled: true })
        expect(effective.tier).toBe(tier)
        expect(effective.actualTier).toBe(tier)
      }
    })

    it('does not raise the seat limit', () => {
      // Beta mode is product capability, not headcount. Raising seats would let an organization add
      // members it loses access to the moment beta ends.
      const effective = applyBetaModeEntitlement(policy({ tier: 'free', seatLimit: 1 }), { enabled: true })
      expect(effective.seatLimit).toBe(1)
    })

    it('preserves the raw billing fields', () => {
      const actual = policy({ tier: 'free', status: 'past_due', active: false })
      const effective = applyBetaModeEntitlement(actual, { enabled: true })
      expect(effective.status).toBe('past_due')
      expect(effective.active).toBe(false)
    })

    it('refuses to unblock a payment-blocked organization', () => {
      // The one case where beta access must lose. Otherwise a promotional flag becomes a way to get free
      // provider work while in dunning.
      const effective = applyBetaModeEntitlement(
        policy({ tier: 'free', paymentBlocked: true }),
        { enabled: true },
      )
      expect(effective.paymentBlocked).toBe(true)
      expect(effective.paidActionsAllowed).toBe(false)
      // Still labelled active, so a surface can explain why the capability is present but unusable.
      expect(effective.betaModeActive).toBe(true)
    })

    it('allows paid actions when nothing else blocks them', () => {
      const effective = applyBetaModeEntitlement(
        policy({ tier: 'free', paidActionsAllowed: false, paymentBlocked: false }),
        { enabled: true },
      )
      expect(effective.paidActionsAllowed).toBe(true)
    })
  })

  it('is reversible with no persisted state', () => {
    // Disabling must need no restoration migration: the same input with the flag off returns the raw
    // policy again.
    const actual = policy({ tier: 'free' })
    const on = applyBetaModeEntitlement(actual, { enabled: true })
    const off = applyBetaModeEntitlement(actual, { enabled: false })
    expect(on.tier).toBe('pro_max')
    expect(off.tier).toBe('free')
    // The resolver never mutates its input, which is what makes that true.
    expect(actual.tier).toBe('free')
  })
})
