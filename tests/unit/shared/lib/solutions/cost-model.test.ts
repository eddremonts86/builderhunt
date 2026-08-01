/**
 * The cost fixtures plan 43 Phase 6 asks for: "cost fixtures prove the selected rate covers certified provider
 * scenarios".
 *
 * These are arithmetic assertions over declared budgets, not measurements. That is the honest description and
 * the limit of what they prove: they show the *fixed price* covers the worst case the code can emit at the
 * pricing constants currently configured, and they pin the multiple by which those constants could be wrong
 * before the conclusion flips. They cannot show the constants are right — `env.ts` documents them as
 * placeholders, and `docs/operations/solutions-cost-certification.md` records that the certification stays
 * provisional until real provider pricing is provisioned.
 */
import { describe, expect, it } from 'vitest'
import { RATE_CARDS } from '~/shared/lib/billing/rate-cards'
import { PACK_CATALOG, SUBSCRIPTION_CATALOG } from '~/shared/lib/billing/catalog'
import {
  SOLUTIONS_CALL_BUDGETS,
  SOLUTIONS_SCENARIOS,
  certifyScenario,
  scenarioCostCents,
  worstCaseCallCostCents,
} from '~/shared/lib/solutions/cost-model'

/** The placeholder MiniMax figures from `env.ts`, restated so the arithmetic below is readable. */
const PRICING = { costPerThousandInputTokensCents: 0.03, costPerThousandOutputTokensCents: 0.12 }

/**
 * The cheapest way to buy a credit, across both ways of buying one.
 *
 * The conservative choice: an organization spending its cheapest credits is the one the margin has to survive.
 * Both sources are considered because a subscription's included credits are bought too — an annual Team plan is
 * 25,200 credits for $1,910 — and certifying against packs alone would miss it if a plan were ever repriced
 * below them. Derived from the catalog rather than hard-coded, so a repricing fails this test instead of
 * silently invalidating the certification.
 */
const perCredit = [
  ...Object.values(PACK_CATALOG)
    .filter((pack) => pack.retiredAt === null)
    .map((pack) => pack.amountCents / pack.credits),
  ...Object.values(SUBSCRIPTION_CATALOG)
    .filter((plan) => plan.retiredAt === null && plan.monthlyCredits > 0)
    .map((plan) => plan.amountCents / (plan.monthlyCredits * (plan.interval === 'annual' ? 12 : 1))),
]
const cheapestCreditCents = Math.min(...perCredit)

const scenario = (key: string) => {
  const found = SOLUTIONS_SCENARIOS.find((entry) => entry.key === key)
  if (!found) throw new Error(`no scenario ${key}`)
  return found
}

describe('worstCaseCallCostCents', () => {
  it('prices a fully-used budget from tokens and rates', () => {
    // interpret: 3000 input @ 0.03¢/1k = 0.09¢, 900 output @ 0.12¢/1k = 0.108¢
    expect(worstCaseCallCostCents(SOLUTIONS_CALL_BUDGETS.interpretBrief, PRICING)).toBeCloseTo(0.198, 6)
    // explain: 2500 input = 0.075¢, 600 output = 0.072¢
    expect(worstCaseCallCostCents(SOLUTIONS_CALL_BUDGETS.explainRoute, PRICING)).toBeCloseTo(0.147, 6)
  })

  it('charges output more than input, as the pricing does', () => {
    // Not a tautology: it is why the explanation budget is the one to watch. An explanation is short input and
    // long prose, so a future prompt change that grows the completion ceiling moves the cost more than one that
    // quotes more evidence into the prompt.
    const budget = { maxInputTokens: 1000, maxOutputTokens: 1000 }
    const inputOnly = worstCaseCallCostCents({ ...budget, maxOutputTokens: 0 }, PRICING)
    const outputOnly = worstCaseCallCostCents({ ...budget, maxInputTokens: 0 }, PRICING)
    expect(outputOnly).toBeGreaterThan(inputOnly)
  })
})

describe('the certified scenarios', () => {
  it('bounds a generate run at five provider calls', () => {
    // `composeRoutes` returns exactly the AI, human, and hybrid lanes, and clarification is one round kept
    // inside the reservation. So this is the maximum the code can emit, not an estimate of typical use.
    const worst = scenario('generate_worst_case')
    expect(worst.interpretCalls + worst.explainCalls).toBe(5)
  })

  it('costs less in the typical case than in the worst case', () => {
    expect(scenarioCostCents(scenario('generate_typical'), PRICING))
      .toBeLessThan(scenarioCostCents(scenario('generate_worst_case'), PRICING))
  })

  it('costs nothing when both LLM flags are off', () => {
    // The deterministic path is genuinely free of provider cost: retrieval is two SQL lanes and composition is
    // arithmetic. This is what makes the flags a real kill switch for spend rather than a feature toggle.
    expect(scenarioCostCents(scenario('generate_no_provider'), PRICING)).toBe(0)
  })
})

describe('the fixed prices cover the worst case', () => {
  it('certifies generate at its 10-credit price', () => {
    const charged = RATE_CARDS.solutions_generate.maxUnits * cheapestCreditCents
    const certification = certifyScenario(scenario('generate_worst_case'), PRICING, charged)

    // 2 × 0.198 + 3 × 0.147 = 0.837¢ of provider cost against 10 × 4.5¢ = 45¢ charged.
    expect(certification.providerCostCents).toBeCloseTo(0.837, 6)
    expect(certification.costToRevenueRatio).toBeLessThan(1)
    // The number that matters: provider prices would have to rise ~53× before this run stops paying for itself.
    // Asserted as a floor rather than an equality so a pack repricing does not fail the test spuriously — but
    // a floor of 10 is high enough that losing it means something real changed.
    expect(certification.breakEvenPriceMultiple).toBeGreaterThan(10)
  })

  it('certifies regenerate at its 3-credit price', () => {
    const charged = RATE_CARDS.solutions_regenerate.maxUnits * cheapestCreditCents
    const certification = certifyScenario(scenario('regenerate_worst_case'), PRICING, charged)
    expect(certification.costToRevenueRatio).toBeLessThan(1)
    expect(certification.breakEvenPriceMultiple).toBeGreaterThan(10)
  })

  it('would fail the certification if a budget grew far enough', () => {
    /**
     * A test that can only pass is not evidence. This one drives the same arithmetic to the point where it
     * refuses, which is what proves the assertions above are load-bearing: a hundredfold output budget makes
     * generate lose money at these prices, and `costToRevenueRatio > 1` is how that is detected rather than by
     * anyone noticing an invoice.
     */
    const inflated = { maxInputTokens: 3000, maxOutputTokens: 900 * 100 }
    const cost = 2 * worstCaseCallCostCents(inflated, PRICING) + 3 * worstCaseCallCostCents(inflated, PRICING)
    const charged = RATE_CARDS.solutions_generate.maxUnits * cheapestCreditCents
    expect(cost / charged).toBeGreaterThan(1)
  })

  it('reports an unbounded break-even for a run that cost nothing', () => {
    const certification = certifyScenario(scenario('generate_no_provider'), PRICING, 45)
    expect(certification.breakEvenPriceMultiple).toBe(Number.POSITIVE_INFINITY)
    expect(certification.costToRevenueRatio).toBe(0)
  })
})

describe('the credit price the certification rests on', () => {
  it('uses the cheapest way to buy a credit, not the dearest', () => {
    expect(cheapestCreditCents).toBeLessThanOrEqual(Math.max(...perCredit))
    // `scale_1000` — 1000 credits for $45 — is the cheapest credit anyone can buy today, cheaper than any
    // plan's included credits. Pinned because the whole margin claim scales with it.
    expect(cheapestCreditCents).toBeCloseTo(4.5, 6)
  })
})
