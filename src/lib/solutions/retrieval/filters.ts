/**
 * Turns a brief into the structured filters retrieval applies (plan 43 Phase 5, "Implement hybrid
 * retrieval": "Apply hard structured filters ... filters are exact").
 *
 * Pure, and separate from the queries that use it, because "exact" is a claim about this file. A filter
 * derived here is applied in SQL by both lanes; a filter expressed as a scoring penalty is not a filter
 * at all, and the difference matters most for the constraints a user relies on — an excluded component
 * must be absent, not merely ranked lower.
 *
 * What is deliberately *not* filtered here: budget and deadline. Those are properties of a whole route,
 * not of a component — a model that costs nothing still costs money once a human reviews its output, so
 * checking a budget against individual candidates would reject combinations that fit and accept ones that
 * do not. The composer checks them against assembled routes.
 */
import type { HardConstraint, SolutionBrief } from '~/shared/lib/solutions/contracts'

/**
 * Component kinds each lane retrieves.
 *
 * Three lanes, matching the three route types the composer must offer. A lane exists so retrieval cannot
 * return only models for a brief that could be answered by a person: the lanes are retrieved
 * independently and fused per lane, so a sparse lane still contributes its best candidates rather than
 * being crowded out by a dense one.
 */
export const RETRIEVAL_LANES = {
  human: ['human_profile', 'human_role'],
  ai: ['agent', 'model', 'model_endpoint'],
  tooling: ['mcp_server', 'tool', 'service'],
} as const

export type RetrievalLane = keyof typeof RETRIEVAL_LANES

export interface RetrievalFilters {
  /** At least one of these must be claimed. Array overlap in SQL, never a text match. */
  capabilityKeys: string[]
  /** Every one of these must be claimed. The composer needs full coverage; retrieval narrows toward it. */
  requiredCapabilityKeys: string[]
  /** Component ids the brief excluded outright. Absent from results, not down-ranked. */
  excludedComponentIds: string[]
  /** Integration keys the brief requires. Matched against a component's metadata by the composer, not
   * here — a component's integrations are not a projection column, and inventing one for a filter nothing
   * yet populates would be a filter that silently excludes everything. */
  requiredIntegrationKeys: string[]
  /** Regulated domains the brief disallows. Same reasoning as integrations: recorded, checked later. */
  disallowedDomains: string[]
}

export function buildRetrievalFilters(brief: SolutionBrief): RetrievalFilters {
  const requiredCapabilityKeys = new Set<string>()
  const excludedComponentIds = new Set<string>()
  const requiredIntegrationKeys = new Set<string>(brief.integrations)
  const disallowedDomains = new Set<string>()

  for (const constraint of brief.hardConstraints) {
    applyConstraint(constraint, { requiredCapabilityKeys, excludedComponentIds, requiredIntegrationKeys, disallowedDomains })
  }

  // The brief's `capabilities` are what it is asking for; a `required_capability` hard constraint is a
  // subset that must be present rather than merely wanted. Both go into the retrieval set — narrowing to
  // only the required ones would hide the components that cover the rest.
  const capabilityKeys = [...new Set([...brief.capabilities, ...requiredCapabilityKeys])]

  return {
    capabilityKeys,
    requiredCapabilityKeys: [...requiredCapabilityKeys],
    excludedComponentIds: [...excludedComponentIds],
    requiredIntegrationKeys: [...requiredIntegrationKeys],
    disallowedDomains: [...disallowedDomains],
  }
}

/**
 * A `switch` over the discriminated union rather than a lookup, so adding a constraint type to
 * `hardConstraintSchema` without deciding what retrieval does about it is a compile error.
 *
 * That matters more than the ergonomics: a new constraint type silently ignored here would be a
 * constraint a user set and the product quietly did not honour.
 */
function applyConstraint(
  constraint: HardConstraint,
  sets: {
    requiredCapabilityKeys: Set<string>
    excludedComponentIds: Set<string>
    requiredIntegrationKeys: Set<string>
    disallowedDomains: Set<string>
  },
): void {
  switch (constraint.type) {
    case 'required_capability':
      sets.requiredCapabilityKeys.add(constraint.capabilityKey)
      return
    case 'excluded_component':
      sets.excludedComponentIds.add(constraint.componentId)
      return
    case 'required_integration':
      sets.requiredIntegrationKeys.add(constraint.integrationKey)
      return
    case 'disallowed_regulated_domain':
      sets.disallowedDomains.add(constraint.domain)
      return
    // Route-level constraints. Not retrieval filters, and pretending otherwise would reject
    // combinations that fit: a free model plus a paid human reviewer can exceed a budget that neither
    // exceeds alone, and a component has no delivery time until it is placed in a route.
    case 'max_budget':
    case 'deadline_by':
    case 'max_data_sensitivity':
      return
  }
}

/**
 * The query text handed to the lexical lane.
 *
 * The deliverable description plus the capability keys, and nothing else. Not the whole brief: budget
 * figures, dates and region codes are not words that appear in a component's document, and including them
 * would add terms that match nothing while diluting the ones that do.
 *
 * Truncated because `websearch_to_tsquery` builds one AND/OR tree per term and a 2000-character
 * description would produce a query slower than the scan it replaces.
 */
export function buildLexicalQuery(brief: SolutionBrief): string {
  const capabilityWords = brief.capabilities.map((key) => key.replace(/_/g, ' ')).join(' ')
  return `${brief.deliverable.description} ${capabilityWords}`.slice(0, 500).trim()
}
