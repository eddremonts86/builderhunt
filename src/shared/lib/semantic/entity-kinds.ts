import { COMPONENT_KINDS, type ComponentKind } from '~/shared/lib/solutions/contracts'

/**
 * What a `builder_embeddings` row can describe (plan: phase-2/07-perfiles-autogestionados).
 *
 * `builder_embeddings.entity_kind` reused `COMPONENT_KINDS` verbatim, and its schema comment says
 * why: one projection indexes humans, roles and catalog components, and a second vocabulary would
 * mean a translation table on the hot retrieval path. That reasoning still holds — this union is
 * the catalog's, plus one.
 *
 * The "plus one" is not added to `COMPONENT_KINDS` itself, because that list is also the CHECK on
 * `solution_components.kind` and `solution_component_projections.kind`. Widening it would make
 * `self_managed_person` a type-legal component kind that both of those tables refuse at the
 * constraint — a type that says yes over a database that says no, which is the worse of the two
 * available mistakes.
 *
 * ## Why a distinct kind at all
 *
 * Indexing self-managed people as `human_profile` would put them in the results of every semantic
 * search that already filters for humans, on the day the indexer ships and with no way for anyone
 * to say no. A separate kind keeps inclusion an explicit request until the shared inclusion policy
 * and its opt-out exist — the same reason the search origin is not in `DEFAULT_SEARCH_SOURCES`.
 */
export const SELF_MANAGED_ENTITY_KIND = 'self_managed_person' as const

export const SEMANTIC_ENTITY_KINDS = [...COMPONENT_KINDS, SELF_MANAGED_ENTITY_KIND] as const
export type SemanticEntityKind = ComponentKind | typeof SELF_MANAGED_ENTITY_KIND
