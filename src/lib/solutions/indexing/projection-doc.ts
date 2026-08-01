/**
 * Builds the lexical document a catalog component is retrieved by (plan 43 Phase 5, "Build versioned
 * search projections").
 *
 * Pure and synchronous on purpose: what text a component is findable by is the single decision that
 * determines whether retrieval can answer a brief at all, so it is a function you can read, test and
 * diff — not a query.
 *
 * The document is *derived prose*, not the metadata JSON. Serialising the metadata would put
 * `"downloads": 69732954` and `"libraryName": "sentence-transformers"` into a full-text index where they
 * match nothing anyone would ask for, while diluting the terms that matter: Postgres `ts_rank` divides by
 * document length, so every irrelevant token makes real matches score lower.
 */
import { createHash } from 'node:crypto'
import { SOLUTION_CAPABILITIES, type CapabilityEvidenceLevel, type ComponentKind } from '~/shared/lib/solutions/contracts'

/**
 * Bumped whenever this file changes what it emits.
 *
 * The projector refuses to replace a projection carrying a higher version than the one it is writing, so
 * a job that started before a rollout cannot overwrite newer work with an older document shape. Raising
 * this number is what marks every existing projection as stale and eligible for rebuild.
 *
 * History:
 *   1 — display name, capability labels, kind, source, and the prose metadata fields.
 */
export const PROJECTION_VERSION = 1

/** Ordered strongest-last, so `maxEvidenceLevel` is a comparison on index rather than a lookup table. */
const EVIDENCE_ORDER: readonly CapabilityEvidenceLevel[] = ['claimed', 'observed', 'verified', 'production_evidence']

const CAPABILITY_LABELS = new Map<string, string>(SOLUTION_CAPABILITIES.map((capability) => [capability.key, capability.label]))

/**
 * Metadata keys whose values are prose worth matching on, and the only ones the document includes.
 *
 * An allowlist rather than "everything that is a string", because the second rule silently starts
 * indexing whatever a new adapter happens to add. A version string or a package name is a string and has
 * no business in a full-text index.
 *
 * `tags` and `keywords` are arrays of short vocabulary terms — included, since they are exactly the
 * words a brief uses, and bounded so a component with 200 tags cannot dominate the index.
 */
const PROSE_KEYS = ['summary', 'description', 'roleTitle', 'companyName', 'area'] as const
const TERM_LIST_KEYS = ['tags', 'keywords'] as const
const MAX_TERMS = 24

export interface ProjectionInput {
  componentId: string
  version: number
  kind: ComponentKind
  sourceKey: string
  displayName: string
  metadata: Record<string, unknown>
  capabilities: ReadonlyArray<{ capabilityKey: string; evidenceLevel: CapabilityEvidenceLevel }>
  observedAt: Date
}

export interface ProjectionRow {
  componentId: string
  version: number
  kind: ComponentKind
  sourceKey: string
  searchDocument: string
  capabilityKeys: string[]
  maxEvidenceLevel: CapabilityEvidenceLevel
  contentHash: string
  projectionVersion: number
  observedAt: Date
}

export function buildProjection(input: ProjectionInput): ProjectionRow {
  const searchDocument = buildSearchDocument(input)
  const capabilityKeys = [...new Set(input.capabilities.map((claim) => claim.capabilityKey))].sort()
  return {
    componentId: input.componentId,
    version: input.version,
    kind: input.kind,
    sourceKey: input.sourceKey,
    searchDocument,
    capabilityKeys,
    maxEvidenceLevel: strongestEvidenceLevel(input.capabilities),
    contentHash: hashProjection({ searchDocument, capabilityKeys, projectionVersion: PROJECTION_VERSION }),
    projectionVersion: PROJECTION_VERSION,
    observedAt: input.observedAt,
  }
}

/**
 * Assembles the document.
 *
 * The display name comes first and is repeated once. Not a trick — Postgres has no field weighting in a
 * plain `to_tsvector`, and a component's name is the term a user is most likely to type verbatim, so it
 * has to survive length normalisation. Repeating it once is the cheapest honest way to say "this token
 * matters more"; `setweight` over concatenated vectors would express it better but requires the generated
 * column to know the document's structure, which is exactly the coupling the derived-prose design avoids.
 *
 * Capability *labels* are included as well as keys, so a brief written in English ("document
 * understanding") matches a component whose claim key is `document_understanding`. The key alone tokenises
 * as one term and would never match the two words a person writes.
 */
function buildSearchDocument(input: ProjectionInput): string {
  const parts: string[] = [input.displayName, input.displayName]

  // Slug-shaped names carry their words joined by punctuation ("bge-small-en-v1.5", "@qvac/sdk"). Split
  // them so the individual words are searchable too, since that is how a person refers to them.
  //
  // Pushed only when splitting actually changes the text: an already-spaced name like "Automation
  // Engineer" splits back to itself, and adding that copy would give it three occurrences to a slug's
  // two — weighting a component higher for having a readable name, which is not a relevance signal.
  //
  // Empty segments are the only ones dropped. A length filter looks tidier but loses the "5" from "v1.5"
  // and the "B" from "A/B Tester"; a single character inside a name is part of the name.
  const splitName = input.displayName.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0).join(' ')
  if (splitName.length > 0 && splitName !== input.displayName) parts.push(splitName)

  parts.push(input.kind.replace(/_/g, ' '))

  for (const claim of input.capabilities) {
    const label = CAPABILITY_LABELS.get(claim.capabilityKey)
    parts.push(claim.capabilityKey.replace(/_/g, ' '))
    if (label) parts.push(label)
  }

  for (const key of PROSE_KEYS) {
    const value = input.metadata[key]
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value.trim())
  }

  const terms: string[] = []
  for (const key of TERM_LIST_KEYS) {
    const value = input.metadata[key]
    if (!Array.isArray(value)) continue
    for (const term of value) {
      if (typeof term !== 'string') continue
      const trimmed = term.trim()
      // Hugging Face tags include `arxiv:2401.03462`, `license:mit` and `model-index` — machine
      // identifiers, not vocabulary. Anything with a colon is dropped rather than indexed as noise.
      if (trimmed.length === 0 || trimmed.length > 40 || trimmed.includes(':')) continue
      terms.push(trimmed)
      if (terms.length >= MAX_TERMS) break
    }
    if (terms.length >= MAX_TERMS) break
  }
  if (terms.length > 0) parts.push(terms.join(' '))

  return parts.join('\n')
}

/** The strongest claim on the component, or `claimed` when it has none — never higher than what exists. */
export function strongestEvidenceLevel(
  capabilities: ReadonlyArray<{ evidenceLevel: CapabilityEvidenceLevel }>,
): CapabilityEvidenceLevel {
  let best = 0
  for (const claim of capabilities) {
    const rank = EVIDENCE_ORDER.indexOf(claim.evidenceLevel)
    if (rank > best) best = rank
  }
  return EVIDENCE_ORDER[best]
}

export function evidenceRank(level: CapabilityEvidenceLevel): number {
  const rank = EVIDENCE_ORDER.indexOf(level)
  return rank < 0 ? 0 : rank
}

/**
 * Hashes what the projection *is*, so an unchanged rebuild writes nothing.
 *
 * `projectionVersion` is part of the hash, which is what makes bumping it invalidate every projection
 * even where the document text happens to be identical — the point of a bump is usually that the same
 * text should now be indexed differently.
 *
 * `observedAt` is deliberately excluded. A source re-serving identical content with a newer timestamp is
 * not a change to what a component is findable by, and including it would rewrite the whole catalog on
 * every refresh.
 */
export function hashProjection(input: { searchDocument: string; capabilityKeys: readonly string[]; projectionVersion: number }): string {
  return createHash('sha256')
    .update(`${input.projectionVersion} ${input.searchDocument} ${[...input.capabilityKeys].sort().join(',')}`)
    .digest('hex')
}
