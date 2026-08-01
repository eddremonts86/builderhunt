/**
 * Checking a brief's hard constraints against an assembled route (plan 43 Phase 5, "Implement the
 * deterministic solution composer": "reject incompatibilities and constraint violations").
 *
 * Pure. These are the checks that decide whether a user is shown a route at all, so they are readable in one
 * file with no database and no scoring.
 *
 * ## Why these are route-level and not retrieval filters
 *
 * A component has no delivery time until it is placed in a route, and a free model plus a paid human reviewer
 * can exceed a budget that neither exceeds alone. Filtering *candidates* on budget or deadline would reject
 * combinations that fit and admit ones that do not, so `buildRetrievalFilters` deliberately ignores them and
 * they are checked here, against the whole thing.
 *
 * ## Unknown is not absent
 *
 * The brief distinguishes a field never asked about (`undefined`) from one asked about and undetermined
 * (`{status:'unknown'}`). That distinction is load-bearing here: an unknown budget cannot be checked, so a
 * route that might exceed it must not be called `recommended`. It is still `available`, with the uncertainty
 * stated. Treating unknown as absent would present a route as vetted against a limit nobody knows.
 */
import type { HardConstraint, SolutionBrief } from '~/shared/lib/solutions/contracts'

export interface RouteFacts {
  /** Every capability the route's components claim, combined. */
  coveredCapabilityKeys: readonly string[]
  /** Component ids the route assigns. */
  componentIds: readonly string[]
  /** Integration keys the route's components declare, where any do. */
  integrationKeys: readonly string[]
  /** Regulated domains the route touches, where any are known. */
  domains: readonly string[]
  /** Total cost interval in the brief's currency, or null when no component could be priced. */
  costCents: { min: number; max: number; currency: string } | null
  /** Delivery interval in hours, or null when nothing could be estimated. */
  timeHours: { min: number; max: number } | null
  /** Highest data sensitivity any component in the route would process. */
  maxDataSensitivity: 'public' | 'internal' | 'confidential' | 'restricted' | null
}

export type ConstraintOutcome =
  /** The route satisfies every checkable constraint. */
  | { kind: 'satisfied' }
  /** A constraint is definitely violated. The route is `unavailable` and says why. */
  | { kind: 'violated'; constraintType: string; reason: string }
  /**
   * A constraint could not be checked, because the brief left the value unknown or the route could not be
   * priced. The route may still be offered — it may not be `recommended`.
   */
  | { kind: 'unverifiable'; constraintType: string; reason: string }

const SENSITIVITY_ORDER = ['public', 'internal', 'confidential', 'restricted'] as const

/**
 * Checks every hard constraint and returns all outcomes, not the first failure.
 *
 * All of them, because a user who set four constraints and violates three deserves to see three reasons. A
 * first-failure check would have them fix one, re-run, and discover the next — three round trips to learn
 * something one answer could have told them.
 */
export function checkConstraints(brief: SolutionBrief, facts: RouteFacts): ConstraintOutcome[] {
  const outcomes: ConstraintOutcome[] = []
  for (const constraint of brief.hardConstraints) {
    outcomes.push(checkOne(constraint, facts))
  }
  return outcomes.filter((outcome) => outcome.kind !== 'satisfied')
}

function checkOne(constraint: HardConstraint, facts: RouteFacts): ConstraintOutcome {
  switch (constraint.type) {
    case 'max_budget': {
      if (!facts.costCents) {
        return {
          kind: 'unverifiable',
          constraintType: constraint.type,
          reason: 'No component in this route could be priced, so the budget could not be checked',
        }
      }
      if (facts.costCents.currency !== constraint.currency) {
        // Converting would require a rate, and a wrong rate turns a budget check into a guess wearing a
        // number. Reported as unverifiable so the user learns the real obstacle.
        return {
          kind: 'unverifiable',
          constraintType: constraint.type,
          reason: `Route is priced in ${facts.costCents.currency}, budget in ${constraint.currency}; no conversion rate is held`,
        }
      }
      // The *lower* bound decides a violation. If even the cheapest reading exceeds the budget, no execution
      // of this route can fit. Using the upper bound would reject routes that fit at the low end, which is
      // most of them.
      if (facts.costCents.min > constraint.maxCents) {
        return {
          kind: 'violated',
          constraintType: constraint.type,
          reason: `Cheapest estimate ${formatMoney(facts.costCents.min, constraint.currency)} exceeds the ${formatMoney(constraint.maxCents, constraint.currency)} budget`,
        }
      }
      // Fits at the low end but might not at the high end. Offerable, not recommendable.
      if (facts.costCents.max > constraint.maxCents) {
        return {
          kind: 'unverifiable',
          constraintType: constraint.type,
          reason: `Upper estimate ${formatMoney(facts.costCents.max, constraint.currency)} may exceed the ${formatMoney(constraint.maxCents, constraint.currency)} budget`,
        }
      }
      return { kind: 'satisfied' }
    }

    case 'deadline_by': {
      if (!facts.timeHours) {
        return { kind: 'unverifiable', constraintType: constraint.type, reason: 'Route has no time estimate, so the deadline could not be checked' }
      }
      const deadline = Date.parse(`${constraint.byDate}T23:59:59Z`)
      if (Number.isNaN(deadline)) {
        return { kind: 'unverifiable', constraintType: constraint.type, reason: 'Deadline is not a readable date' }
      }
      // Deliberately *not* computed against `Date.now()`. A composer that consulted the clock would give a
      // different answer for the same brief tomorrow, and a solution run has to be reproducible from its
      // recorded inputs. The available window is a property of the request; the composer only reports the
      // route's duration and lets the caller — which knows when the brief was submitted — decide.
      return {
        kind: 'unverifiable',
        constraintType: constraint.type,
        reason: `Route needs ${formatHours(facts.timeHours.min)}–${formatHours(facts.timeHours.max)}; whether that meets ${constraint.byDate} depends on when work starts`,
      }
    }

    case 'max_data_sensitivity': {
      if (!facts.maxDataSensitivity) {
        return { kind: 'unverifiable', constraintType: constraint.type, reason: 'No component states what data sensitivity it processes' }
      }
      const allowed = SENSITIVITY_ORDER.indexOf(constraint.level)
      const required = SENSITIVITY_ORDER.indexOf(facts.maxDataSensitivity)
      if (required > allowed) {
        return {
          kind: 'violated',
          constraintType: constraint.type,
          reason: `Route processes ${facts.maxDataSensitivity} data, above the ${constraint.level} limit`,
        }
      }
      return { kind: 'satisfied' }
    }

    case 'required_capability':
      return facts.coveredCapabilityKeys.includes(constraint.capabilityKey)
        ? { kind: 'satisfied' }
        : {
            kind: 'violated',
            constraintType: constraint.type,
            reason: `No component in this route claims ${constraint.capabilityKey}`,
          }

    case 'excluded_component':
      // Retrieval already excludes these, so reaching here means something assembled a route from a candidate
      // it should never have seen. Checked anyway: a constraint enforced in one place is a constraint the next
      // code path can forget.
      return facts.componentIds.includes(constraint.componentId)
        ? { kind: 'violated', constraintType: constraint.type, reason: `Route includes the excluded component ${constraint.componentId}` }
        : { kind: 'satisfied' }

    case 'required_integration':
      // Absence of *declared* integrations is not absence of the integration. Nothing in the catalog populates
      // this field yet, so claiming a violation would reject every route on the strength of a field nobody
      // fills in.
      if (facts.integrationKeys.length === 0) {
        return {
          kind: 'unverifiable',
          constraintType: constraint.type,
          reason: `No component declares its integrations, so ${constraint.integrationKey} could not be confirmed`,
        }
      }
      return facts.integrationKeys.includes(constraint.integrationKey)
        ? { kind: 'satisfied' }
        : { kind: 'violated', constraintType: constraint.type, reason: `No component integrates with ${constraint.integrationKey}` }

    case 'disallowed_regulated_domain':
      // Same reasoning inverted, and the asymmetry is deliberate: for a *disallowed* domain, silence is safe.
      // "We do not know that this route touches medical data" does not need to block the route, whereas "we do
      // not know that it integrates with Slack" cannot confirm a requirement.
      return facts.domains.includes(constraint.domain)
        ? { kind: 'violated', constraintType: constraint.type, reason: `Route touches the disallowed domain ${constraint.domain}` }
        : { kind: 'satisfied' }
  }
}

function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`
}

function formatHours(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)}min` : `${Math.round(hours * 10) / 10}h`
}

/**
 * Whether the brief left a field unknown rather than unasked.
 *
 * A route cannot be `recommended` against an unknown hard-constraint field: presenting it as vetted would
 * claim a check nobody could perform. It can still be `available`, with the uncertainty stated as a
 * limitation.
 */
export function unknownHardFields(brief: SolutionBrief): string[] {
  const unknown: string[] = []
  if (brief.budget?.status === 'unknown') unknown.push('budget')
  if (brief.deadline?.status === 'unknown') unknown.push('deadline')
  if (brief.privacy?.status === 'unknown') unknown.push('privacy')
  if (brief.quality?.status === 'unknown') unknown.push('quality')
  if (brief.supervision?.status === 'unknown') unknown.push('supervision')
  if (brief.autonomyCeiling?.status === 'unknown') unknown.push('autonomyCeiling')
  return unknown
}
