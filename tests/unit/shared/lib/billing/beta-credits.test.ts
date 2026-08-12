import { describe, expect, it } from 'vitest'
import {
  activeBetaSourceReference,
  BETA_MONTHLY_UNITS,
  deriveBetaCreditWindow,
  isBetaGrantEligible,
} from '~/shared/lib/billing/beta-credits'

/**
 * The pure half of plan 58's credit accounting.
 *
 * `deriveBetaCreditWindow` and `isBetaGrantEligible` carry the whole reversibility story — immediate
 * disable, automatic month rollover, re-enable restoring only the unused remainder — and none of it
 * needs a database. Minting and claiming do, and are covered by the integration and browser passes.
 */
const ORG = 'org_123'

describe('deriveBetaCreditWindow', () => {
  it('keys on the UTC month, not the local one', () => {
    // 00:30 on the 1st in UTC is still the previous month in the Americas. Deriving the window from
    // local time would give two organizations different answers for the same instant.
    const window = deriveBetaCreditWindow(new Date('2026-03-01T00:30:00Z'), ORG)
    expect(window.key).toBe('2026-03')
    expect(window.sourceReference).toBe('beta-mode:2026-03')
    expect(window.monthlyWindowKey).toBe(`beta-mode:${ORG}:2026-03`)
  })

  it('expires at the first instant of the next UTC month', () => {
    const window = deriveBetaCreditWindow(new Date('2026-03-17T12:00:00Z'), ORG)
    expect(window.expiresAt.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('rolls December into the next January', () => {
    // `Date.UTC(year, 12, 1)` is the case a hand-rolled `month + 1` gets wrong.
    const window = deriveBetaCreditWindow(new Date('2026-12-31T23:59:59Z'), ORG)
    expect(window.key).toBe('2026-12')
    expect(window.expiresAt.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('pads single-digit months so the key sorts lexicographically', () => {
    expect(deriveBetaCreditWindow(new Date('2026-01-05T00:00:00Z'), ORG).key).toBe('2026-01')
    expect(deriveBetaCreditWindow(new Date('2026-09-05T00:00:00Z'), ORG).key).toBe('2026-09')
  })

  it('scopes the at-most-once key per organization but shares the reference', () => {
    const now = new Date('2026-03-17T12:00:00Z')
    const a = deriveBetaCreditWindow(now, 'org_a')
    const b = deriveBetaCreditWindow(now, 'org_b')
    // One grant each…
    expect(a.monthlyWindowKey).not.toBe(b.monthlyWindowKey)
    // …but eligibility is a property of the month, so the reference is shared.
    expect(a.sourceReference).toBe(b.sourceReference)
  })
})

describe('isBetaGrantEligible', () => {
  const betaMarch = { source: 'promotional', sourceReference: 'beta-mode:2026-03' }
  const betaFebruary = { source: 'promotional', sourceReference: 'beta-mode:2026-02' }
  const paid = { source: 'subscription_monthly', sourceReference: 'sub_123' }
  const pack = { source: 'pack', sourceReference: 'pi_456' }
  const otherPromo = { source: 'promotional', sourceReference: 'launch-week' }

  it('always allows paid and pack grants, whatever beta is doing', () => {
    for (const reference of [null, 'beta-mode:2026-03']) {
      expect(isBetaGrantEligible(paid, reference)).toBe(true)
      expect(isBetaGrantEligible(pack, reference)).toBe(true)
    }
  })

  it('allows a promotional grant that is not a beta grant', () => {
    // The predicate keys on the `beta-mode:` prefix, not on `source`, so an unrelated promotion is not
    // collateral damage when beta mode is switched off.
    expect(isBetaGrantEligible(otherPromo, null)).toBe(true)
  })

  it('makes disable immediate', () => {
    // No mutation, no deletion — the grant simply stops being eligible on the next query.
    expect(isBetaGrantEligible(betaMarch, 'beta-mode:2026-03')).toBe(true)
    expect(isBetaGrantEligible(betaMarch, null)).toBe(false)
  })

  it('retires last month before the expiry worker runs', () => {
    expect(isBetaGrantEligible(betaFebruary, 'beta-mode:2026-03')).toBe(false)
  })

  it('restores only the unused remainder when re-enabled in the same month', () => {
    // Nothing was clawed back, so the same row becomes eligible again with whatever balance is left.
    expect(isBetaGrantEligible(betaMarch, null)).toBe(false)
    expect(isBetaGrantEligible(betaMarch, 'beta-mode:2026-03')).toBe(true)
  })
})

describe('activeBetaSourceReference', () => {
  it('is null with beta off, so nothing downstream has to know why', () => {
    expect(activeBetaSourceReference({ enabled: false }, ORG, new Date('2026-03-17T12:00:00Z'))).toBeNull()
  })

  it('is this month with beta on', () => {
    expect(activeBetaSourceReference({ enabled: true }, ORG, new Date('2026-03-17T12:00:00Z')))
      .toBe('beta-mode:2026-03')
  })
})

describe('the allowance', () => {
  it('is 700 units, matching the Pro Max monthly grant in the catalog', () => {
    expect(BETA_MONTHLY_UNITS).toBe(700)
  })
})
