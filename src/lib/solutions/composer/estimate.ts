/**
 * Cost and time intervals for a route (plan 43 Phase 5: "calculate estimate intervals").
 *
 * Pure. Every number a user sees comes from here, so the rules that produce them are readable in one place.
 *
 * ## Intervals, never point estimates
 *
 * The contract requires `costMinCents <= costMaxCents` and the same for time, and the reason is not
 * bookkeeping: a single number implies a precision nobody has. A route's cost depends on volume, on how many
 * review rounds it takes, and on rates that were advertised rather than agreed. An interval says that.
 *
 * ## Where the numbers come from
 *
 * Human effort is priced from `findMarketRateBand` — real advertised salaries for comparable roles, from the
 * job feeds. That is evidence. A hardcoded rate card would be a guess with a confident face on it, and worse,
 * a guess nobody could audit.
 *
 * AI components are **not** priced at all, and that is deliberate rather than pending. Per-token pricing is
 * held nowhere in this product, changes without notice, and depends on volume the brief usually leaves
 * unknown. A route made only of models therefore reports no cost, and `checkConstraints` reports the budget as
 * *unverifiable* — which is true, and better than a fabricated figure the user would plan around.
 */
import type { QualityBar, SolutionBrief } from '~/shared/lib/solutions/contracts'
import type { MarketRateBand } from '~/lib/solutions/retrieval/market-rates'

export interface EstimateInput {
  brief: SolutionBrief
  /** Advertised-salary band for the kind of role this route needs, when one could be derived. */
  marketRate: MarketRateBand | null
  /** Components in the route, by kind, so human effort can be separated from tooling. */
  componentKinds: readonly string[]
}

export interface RouteEstimate {
  costMinCents: number
  costMaxCents: number
  currency: string
  timeMinHours: number
  timeMaxHours: number
  /** Every assumption the numbers rest on, stated. A user who disagrees with an assumption can discount the
   * estimate rather than discovering later that it assumed something they would have corrected. */
  assumptions: string[]
}

/**
 * Hours of human effort implied by the brief's scale.
 *
 * Coarse, and the coarseness is honest: the brief's `magnitude` is one of four buckets, so pretending to
 * derive a tighter number from it would be false precision. The ranges are wide because the input is.
 */
const SCALE_HOURS: Record<string, { min: number; max: number }> = {
  one_off: { min: 1, max: 4 },
  small: { min: 4, max: 16 },
  medium: { min: 16, max: 60 },
  large: { min: 60, max: 200 },
}

/** Multipliers for the quality bar. A higher bar means more review, not a different person. */
const QUALITY_EFFORT: Record<QualityBar, number> = {
  draft: 0.6,
  standard: 1,
  high: 1.5,
  expert: 2.2,
}

/** Working hours in a year, for turning an annual salary into an hourly rate. */
const BILLABLE_HOURS_PER_YEAR = 1600

export function estimateRoute(input: EstimateInput): RouteEstimate | null {
  const assumptions: string[] = []

  const scale = input.brief.scale?.status === 'known' ? input.brief.scale.value.magnitude : null
  const hours = scale ? SCALE_HOURS[scale] : SCALE_HOURS.small
  if (!scale) {
    // Stated rather than silently assumed. A user who meant "large" can see that the estimate did not.
    assumptions.push('Scale was not specified; estimated as a small engagement')
  }

  const quality = input.brief.quality?.status === 'known' ? input.brief.quality.value : 'standard'
  const effort = QUALITY_EFFORT[quality]
  if (input.brief.quality?.status !== 'known') {
    assumptions.push('Quality bar was not specified; estimated at the standard bar')
  }

  const humanCount = input.componentKinds.filter((kind) => kind === 'human_profile' || kind === 'human_role').length
  const timeMinHours = round(hours.min * effort)
  const timeMaxHours = round(hours.max * effort)

  if (humanCount === 0) {
    // No human in the route means no priceable component. Reported as no estimate rather than as zero: zero
    // is a claim that it is free, and the contract's refinement would happily accept it.
    return null
  }

  if (!input.marketRate) {
    return null
  }

  // The band's own spread carries into the estimate. Using only the median would present one number's
  // precision for a market that had a 25th-to-75th-percentile range.
  const hourlyLow = input.marketRate.p25 / BILLABLE_HOURS_PER_YEAR
  const hourlyHigh = input.marketRate.p75 / BILLABLE_HOURS_PER_YEAR

  assumptions.push(
    `Rate from ${input.marketRate.sampleSize} advertised ${input.marketRate.currency} salaries for comparable roles (${input.marketRate.sourceKeys.join(', ')})`,
    `Annual salary converted at ${BILLABLE_HOURS_PER_YEAR} billable hours per year`,
  )
  if (input.marketRate.otherCurrencySamples > 0) {
    assumptions.push(`${input.marketRate.otherCurrencySamples} comparable postings in other currencies were excluded`)
  }
  if (input.componentKinds.some((kind) => kind === 'model' || kind === 'model_endpoint' || kind === 'tool')) {
    // The user must not read a human-only figure as the route's total.
    assumptions.push('Model and tool usage is not priced; this covers human effort only')
  }

  return {
    costMinCents: Math.round(timeMinHours * hourlyLow * 100),
    costMaxCents: Math.round(timeMaxHours * hourlyHigh * 100),
    currency: input.marketRate.currency,
    timeMinHours,
    timeMaxHours,
    assumptions,
  }
}

/**
 * A time-only estimate, for a route with no human to price.
 *
 * The contract requires an estimate on any route that is not `unavailable`, and a route of models still takes
 * time even when it costs an unknown amount. Zero cost with a stated assumption is the honest shape: it says
 * "we did not price this", where omitting the estimate would make the route unofferable and inventing a cost
 * would be worse than either.
 */
export function timeOnlyEstimate(input: EstimateInput): RouteEstimate {
  const scale = input.brief.scale?.status === 'known' ? input.brief.scale.value.magnitude : null
  const hours = scale ? SCALE_HOURS[scale] : SCALE_HOURS.small
  const quality = input.brief.quality?.status === 'known' ? input.brief.quality.value : 'standard'
  const effort = QUALITY_EFFORT[quality]

  const assumptions = ['Cost is not estimated: this product holds no per-token or per-call pricing']
  if (!scale) assumptions.push('Scale was not specified; estimated as a small engagement')
  if (input.brief.quality?.status !== 'known') assumptions.push('Quality bar was not specified; estimated at the standard bar')

  return {
    costMinCents: 0,
    costMaxCents: 0,
    currency: input.brief.budget?.status === 'known' ? input.brief.budget.value.currency : 'EUR',
    timeMinHours: round(hours.min * effort),
    timeMaxHours: round(hours.max * effort),
    assumptions,
  }
}

function round(hours: number): number {
  return Math.round(hours * 10) / 10
}
