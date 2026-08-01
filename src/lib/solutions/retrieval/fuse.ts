/**
 * Reciprocal rank fusion, evidence and freshness scoring, and diversity (plan 43 Phase 5, "Implement
 * hybrid retrieval": "normalized reciprocal-rank fusion, evidence/freshness scoring, diversity").
 *
 * Pure. Every ordering decision retrieval makes is in this file, so "why is this component third" is
 * answerable by reading one function rather than by reasoning about two query plans.
 */
import { evidenceRank } from '~/lib/solutions/indexing/projection-doc'
import type { CapabilityEvidenceLevel } from '~/shared/lib/solutions/contracts'

/**
 * RRF's damping constant.
 *
 * 60 is the value from the original TREC work and the one `src/lib/score.ts` already uses for fusing
 * search connectors. Matching it is deliberate: two different constants in one product would mean
 * "position 3" carried different weight in two places for no reason anyone could state.
 *
 * What it buys: fusing raw scores from a `ts_rank` and a cosine distance would compare numbers on
 * incomparable scales, and whichever lane happened to produce larger values would dominate. Ranks are
 * comparable by construction.
 */
export const RRF_K = 60

export interface LaneHit {
  componentId: string
  version: number
  /** 1-based position within its own lane. */
  rank: number
}

export interface FusionCandidate {
  componentId: string
  version: number
  kind: string
  sourceKey: string
  displayName: string
  capabilityKeys: string[]
  maxEvidenceLevel: CapabilityEvidenceLevel
  observedAt: Date
}

export interface ScoredCandidate extends FusionCandidate {
  /** Sum of `1/(k + rank)` over the lanes that returned this component. */
  fusionScore: number
  /** Which lanes found it, for the trace. A component found by both is a stronger signal than one found
   * by either alone, and this is what makes that visible rather than only implied by the score. */
  foundBy: string[]
  evidenceScore: number
  freshnessScore: number
  /** What the ordering actually uses. */
  finalScore: number
}

/**
 * Fuses per-lane rankings and scores the result.
 *
 * Fusion, evidence and freshness are combined multiplicatively on two bounded factors rather than as a
 * weighted sum. A sum lets a very fresh component with nothing asserted about it outrank a verified one,
 * because the terms trade off freely; multiplying by factors that never reach zero means evidence and
 * freshness can *modulate* relevance but never replace it. A component nothing has claimed is still
 * ranked — just below an equally relevant one that has evidence.
 */
export function fuseAndScore(
  candidates: readonly FusionCandidate[],
  lanes: Readonly<Record<string, readonly LaneHit[]>>,
  now: Date,
): ScoredCandidate[] {
  const fusion = new Map<string, { score: number; foundBy: string[] }>()
  for (const [laneName, hits] of Object.entries(lanes)) {
    for (const hit of hits) {
      const key = `${hit.componentId}:${hit.version}`
      const entry = fusion.get(key) ?? { score: 0, foundBy: [] }
      entry.score += 1 / (RRF_K + hit.rank)
      entry.foundBy.push(laneName)
      fusion.set(key, entry)
    }
  }

  return candidates
    .map((candidate) => {
      const entry = fusion.get(`${candidate.componentId}:${candidate.version}`) ?? { score: 0, foundBy: [] }
      const evidenceScore = evidenceFactor(candidate.maxEvidenceLevel)
      const freshnessScore = freshnessFactor(candidate.observedAt, now)
      return {
        ...candidate,
        fusionScore: entry.score,
        foundBy: [...entry.foundBy].sort(),
        evidenceScore,
        freshnessScore,
        finalScore: entry.score * evidenceScore * freshnessScore,
      }
    })
    .sort(byScoreThenId)
}

/**
 * Ordering, with a deterministic tiebreak.
 *
 * The tiebreak is not cosmetic. Two components with identical scores appearing in a different order on
 * two runs of the same brief would make a solution run irreproducible, and reproducibility is what lets a
 * recommendation be audited against the evidence it cited.
 */
function byScoreThenId(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore
  return a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0
}

/**
 * Evidence as a bounded multiplier: 1.0 for a claim nobody checked, up to 1.6 for production evidence.
 *
 * Bounded below at 1.0 rather than scaling from 0, because a self-declared claim is still information —
 * a vendor saying its model translates is usually true. Zeroing it would mean an unverified but perfectly
 * relevant component never appears at all, which is worse advice than showing it with its evidence level
 * stated.
 */
export function evidenceFactor(level: CapabilityEvidenceLevel): number {
  return 1 + evidenceRank(level) * 0.2
}

/**
 * Freshness as a bounded multiplier: 1.0 for something observed today, decaying toward a floor of 0.6
 * over a year.
 *
 * A floor, not a decay to zero. A three-year-old catalog entry for a tool that still exists is stale
 * information, not wrong information, and a model that decayed to zero would rank a freshly-crawled
 * irrelevant component above a well-established relevant one. Retrieval's job is to surface it and let the
 * age be shown.
 *
 * A future `observedAt` (clock skew on an ingest host) is treated as today rather than rewarded — the
 * alternative is a component gaming its way to the top by claiming to be from next year.
 */
export function freshnessFactor(observedAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - observedAt.getTime()) / 86_400_000)
  const decay = Math.min(1, ageDays / 365)
  return 1 - decay * 0.4
}

export interface DiversityLimits {
  /** Most results one source may contribute. */
  maxPerSource: number
  /** Most results one component kind may contribute. */
  maxPerKind: number
  limit: number
}

export interface DiversityOutcome {
  results: ScoredCandidate[]
  /** Candidates dropped only because a cap was already met, by cap. Reported rather than silently
   * discarded: "npm contributed 40 of your 50 results" is a fact about the catalog's shape that an
   * operator needs, and a silent cap reads as "this is all there was". */
  suppressedBySource: number
  suppressedByKind: number
}

/**
 * Caps how much of a result set any one source or kind can occupy.
 *
 * Without this, retrieval returns whatever the catalog happens to hold most of. The npm registry has
 * millions of packages and Hugging Face hundreds of thousands of models, so a brief asking for
 * "translation" would come back as fifty npm packages and no human and no service — not because that is
 * the best answer but because that is what was ingested most.
 *
 * Applied *after* scoring and in score order, so the cap removes the weakest members of an
 * over-represented group rather than an arbitrary slice.
 */
export function diversify(candidates: readonly ScoredCandidate[], limits: DiversityLimits): DiversityOutcome {
  const perSource = new Map<string, number>()
  const perKind = new Map<string, number>()
  const results: ScoredCandidate[] = []
  let suppressedBySource = 0
  let suppressedByKind = 0

  for (const candidate of candidates) {
    if (results.length >= limits.limit) break
    const sourceCount = perSource.get(candidate.sourceKey) ?? 0
    if (sourceCount >= limits.maxPerSource) {
      suppressedBySource += 1
      continue
    }
    const kindCount = perKind.get(candidate.kind) ?? 0
    if (kindCount >= limits.maxPerKind) {
      suppressedByKind += 1
      continue
    }
    perSource.set(candidate.sourceKey, sourceCount + 1)
    perKind.set(candidate.kind, kindCount + 1)
    results.push(candidate)
  }

  return { results, suppressedBySource, suppressedByKind }
}
