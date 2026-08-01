/**
 * What a Solutions run may cost a provider, and whether the fixed price covers it (plan 43 Phase 6,
 * "Register Solutions rate cards with billing": "cost fixtures prove the selected rate covers certified
 * provider scenarios").
 *
 * Pure arithmetic over declared budgets — no provider, no database, no environment beyond the cost constants
 * passed in. It exists so the figure in `billing/rate-cards.ts` is derived and testable rather than asserted,
 * and so `docs/operations/solutions-cost-certification.md` and the rate card cannot drift apart: the doc quotes
 * this module's output, and a test recomputes it.
 *
 * ## Why the token budgets live here and not in `ai/tasks.ts`
 *
 * Phase 7 registers `solutions_interpret_brief` and `solutions_explain_route` in the AI task registry, and
 * their `maxOutputTokens` must equal `SOLUTIONS_CALL_BUDGETS` — a test asserts it once those tasks exist. The
 * budgets are declared here because the *price* depends on them: a Phase 7 change that quietly doubled an
 * output budget would double the provider cost of an operation whose price is already fixed and already
 * confirmed by users, and the only way to catch that is for the two to share one source.
 */

export interface CallBudget {
  /** Prompt ceiling, including the brief, the route, and the evidence rows quoted into it. */
  maxInputTokens: number
  /** Completion ceiling. The same number Phase 7 must register as the task's `maxOutputTokens`. */
  maxOutputTokens: number
}

/**
 * The per-call ceilings for the two provider-backed Solutions calls.
 *
 * Input dominates the interpretation call because a brief is free text a user pasted; it dominates less in
 * explanation, where the input is a composed route plus its evidence rows and is bounded by the composer's own
 * `maxComponents`.
 */
export const SOLUTIONS_CALL_BUDGETS = {
  interpretBrief: { maxInputTokens: 3000, maxOutputTokens: 900 },
  explainRoute: { maxInputTokens: 2500, maxOutputTokens: 600 },
} as const satisfies Record<string, CallBudget>

export interface ProviderPricing {
  costPerThousandInputTokensCents: number
  costPerThousandOutputTokensCents: number
}

/**
 * Provider requests per logical call.
 *
 * `minimaxChat` retries once with a JSON-correction turn when the first answer does not parse or validate, and
 * that retry re-sends the whole prompt and can use the whole output budget again. So one *call* in the scenarios
 * below is up to two billed requests.
 *
 * Missed in the first version of this model, which counted logical calls and understated the worst case by
 * exactly half. Worth stating rather than folding into the budgets: the factor belongs to the client's retry
 * policy, and a change there changes the cost of every operation.
 */
export const PROVIDER_ATTEMPTS_PER_CALL = 2

/** Cost in cents of one attempt that used its entire budget. */
export function worstCaseCallCostCents(budget: CallBudget, pricing: ProviderPricing): number {
  return (budget.maxInputTokens / 1000) * pricing.costPerThousandInputTokensCents
    + (budget.maxOutputTokens / 1000) * pricing.costPerThousandOutputTokensCents
}

export interface SolutionsScenario {
  key: string
  /** What a reader needs to know to judge whether the scenario is the worst case. */
  description: string
  interpretCalls: number
  explainCalls: number
}

/**
 * The scenarios the rate card is certified against.
 *
 * `generate_worst_case` is the ceiling the price has to cover: spec.md requires clarification to stay *inside*
 * the reservation ("keep clarification inside that reservation"), so a brief that needed one clarification
 * round runs interpretation twice, and a run that offered all three routes explains three times. Nothing in
 * the composer can produce a fourth route — `composeRoutes` returns exactly the AI, human, and hybrid lanes —
 * so five provider calls is not a guess about typical use, it is the maximum the code can emit.
 *
 * `regenerate_worst_case` carries no interpretation: a rerun reuses the stored interpretation and retrieval and
 * only re-explains.
 */
export const SOLUTIONS_SCENARIOS: readonly SolutionsScenario[] = [
  {
    key: 'generate_no_provider',
    description: 'Deterministic answer: retrieval and composition only, interpretation and explanation disabled by flag',
    interpretCalls: 0,
    explainCalls: 0,
  },
  {
    key: 'generate_typical',
    description: 'One interpretation, two offerable routes explained',
    interpretCalls: 1,
    explainCalls: 2,
  },
  {
    key: 'generate_worst_case',
    description: 'One clarification round (two interpretations) and all three routes explained',
    interpretCalls: 2,
    explainCalls: 3,
  },
  {
    key: 'regenerate_worst_case',
    description: 'No interpretation; all three routes re-explained',
    interpretCalls: 0,
    explainCalls: 3,
  },
]

/** Worst case: every call uses its whole budget and every call needs its correction retry. */
export function scenarioCostCents(scenario: SolutionsScenario, pricing: ProviderPricing): number {
  const perInterpret = worstCaseCallCostCents(SOLUTIONS_CALL_BUDGETS.interpretBrief, pricing)
  const perExplain = worstCaseCallCostCents(SOLUTIONS_CALL_BUDGETS.explainRoute, pricing)
  return PROVIDER_ATTEMPTS_PER_CALL * (scenario.interpretCalls * perInterpret + scenario.explainCalls * perExplain)
}

export interface ScenarioCertification {
  key: string
  description: string
  providerCostCents: number
  chargedCents: number
  /** Provider cost as a fraction of what is charged. Above 1 means the run loses money. */
  costToRevenueRatio: number
  /**
   * How much the provider's prices could rise before this scenario stops paying for itself.
   *
   * The number worth reading. The absolute cents figures are only as good as the pricing constants — which are
   * documented placeholders — while this says how wrong they can be before the conclusion changes.
   */
  breakEvenPriceMultiple: number
}

/**
 * Certifies one scenario against what it is charged.
 *
 * `chargedCents` is credits × the cost of a credit, and the cheapest way to buy a credit is what to use: an
 * organization spending its cheapest credits is the one the margin has to survive. Using the dearest pack would
 * certify a price nobody pays.
 */
export function certifyScenario(
  scenario: SolutionsScenario,
  pricing: ProviderPricing,
  chargedCents: number,
): ScenarioCertification {
  const providerCostCents = scenarioCostCents(scenario, pricing)
  return {
    key: scenario.key,
    description: scenario.description,
    providerCostCents,
    chargedCents,
    // A zero-provider scenario charges without cost, so the ratio is 0 and the multiple is unbounded. Reported
    // as Infinity rather than a sentinel number, so an arithmetic comparison stays honest.
    costToRevenueRatio: chargedCents === 0 ? 0 : providerCostCents / chargedCents,
    breakEvenPriceMultiple: providerCostCents === 0 ? Number.POSITIVE_INFINITY : chargedCents / providerCostCents,
  }
}
