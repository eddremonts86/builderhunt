/**
 * Hybrid retrieval (plan 43 Phase 5, "Implement hybrid retrieval").
 *
 * Runs the lexical and vector lanes per route lane, fuses them by rank, scores by evidence and freshness,
 * diversifies, and emits a trace. Reranking stays disabled — the plan's own task says so, and adopting one
 * requires the evaluation in `docs/operations/solutions-evaluation.md` to show a predeclared gain.
 *
 * **Degrading safely is a requirement, not a nicety.** Either backend can be unavailable: pgvector needs
 * an embedding provider to have run, and the embedding call itself can fail. A retrieval that returned
 * nothing because one lane errored would turn a provider blip into "we found no way to do this", which is
 * a wrong answer rather than a missing one. So each lane is caught individually, its failure is recorded
 * in the trace, and the surviving lane's results are still fused and returned.
 *
 * The trace is not debug output. A solution run records `retrievalQueryHash` and the component versions it
 * cited so a recommendation can be audited later; the trace is what makes "why was this component
 * considered" answerable at that point.
 */
import { createHash } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '~/shared/lib/db/client'
import { canonicalJson } from '~/shared/lib/ai/cache'
import { log } from '~/shared/lib/log'
import { metrics } from '~/shared/lib/metrics'
import type { ComponentKind, SolutionBrief } from '~/shared/lib/solutions/contracts'
import { RETRIEVAL_LANES, buildLexicalQuery, buildRetrievalFilters, type RetrievalFilters, type RetrievalLane } from './filters'
import { diversify, fuseAndScore, type LaneHit, type ScoredCandidate } from './fuse'
import { LANE_LIMIT, lexicalLane, loadCandidates, vectorLane } from './lanes'

/** Results returned per lane before diversity caps. */
const DEFAULT_LANE_RESULTS = 12
/** No single source may fill a lane. See `diversify`'s note on catalog shape. */
const MAX_PER_SOURCE = 4
const MAX_PER_KIND = 6

export type BackendHealth = 'ok' | 'unavailable' | 'skipped'

export interface LaneTrace {
  lane: RetrievalLane
  kinds: readonly ComponentKind[]
  lexicalHits: number
  vectorHits: number
  candidates: number
  returned: number
  suppressedBySource: number
  suppressedByKind: number
}

export interface RetrievalTrace {
  /** Stable over identical (brief, catalog state) so a run can be reproduced and audited. */
  queryHash: string
  lexical: BackendHealth
  vector: BackendHealth
  /** Present only when a backend is `unavailable`. Never the raw error — an upstream body could echo
   * anything, including a prompt-injected string. */
  vectorDetail?: string
  lexicalDetail?: string
  filters: RetrievalFilters
  lanes: LaneTrace[]
  durationMs: number
  /** True when reranking was considered and deliberately not applied. Recorded so a run's trace states
   * which retrieval design produced it rather than leaving it to be inferred from a date. */
  rerankerApplied: false
}

export interface RetrievalResult {
  /** Per route lane, so the composer can build a human, an AI and a hybrid route from real candidates
   * instead of slicing one flat list and hoping it contains a person. */
  byLane: Record<RetrievalLane, ScoredCandidate[]>
  trace: RetrievalTrace
}

export interface RetrieveOptions {
  /** Supplies the query vector. Omitted or returning null means the vector lane is skipped rather than
   * failed — a caller with no embedding provider configured is not an error condition. */
  embed?: (text: string) => Promise<number[] | null>
  perLane?: number
  now?: Date
  db?: PostgresJsDatabase
}

export async function retrieveForBrief(brief: SolutionBrief, options: RetrieveOptions = {}): Promise<RetrievalResult> {
  const db = options.db ?? publicDb
  const now = options.now ?? new Date()
  const started = Date.now()
  const filters = buildRetrievalFilters(brief)
  const queryText = buildLexicalQuery(brief)

  // Embedding once for every lane, not once per lane: the query text is the same, and three identical
  // provider calls would triple the cost and the latency of the slowest step in retrieval.
  let queryVector: number[] | null = null
  let vectorHealth: BackendHealth = 'skipped'
  let vectorDetail: string | undefined
  if (options.embed) {
    try {
      queryVector = await options.embed(queryText)
      vectorHealth = queryVector ? 'ok' : 'skipped'
    } catch (error) {
      vectorHealth = 'unavailable'
      vectorDetail = 'Embedding provider unavailable'
      log.warn('solutions_retrieval_embed_failed', { error: error instanceof Error ? error.message : String(error) })
      metrics.increment('solutionsRetrievalVectorFailures')
    }
  }

  let lexicalHealth: BackendHealth = 'ok'
  let lexicalDetail: string | undefined
  const byLane = {} as Record<RetrievalLane, ScoredCandidate[]>
  const laneTraces: LaneTrace[] = []

  for (const lane of Object.keys(RETRIEVAL_LANES) as RetrievalLane[]) {
    const kinds = RETRIEVAL_LANES[lane] as readonly ComponentKind[]
    const laneInput = { kinds, filters, limit: LANE_LIMIT }

    let lexicalHits: LaneHit[] = []
    try {
      lexicalHits = await lexicalLane(queryText, laneInput, db)
    } catch (error) {
      // One lane's failure must not take the others down: a malformed tsquery or a missing index affects
      // this lane only, and the vector lane may still have an answer.
      lexicalHealth = 'unavailable'
      lexicalDetail = 'Full-text search unavailable'
      log.warn('solutions_retrieval_lexical_failed', { lane, error: error instanceof Error ? error.message : String(error) })
      metrics.increment('solutionsRetrievalLexicalFailures')
    }

    let vectorHits: LaneHit[] = []
    if (queryVector) {
      try {
        vectorHits = await vectorLane(queryVector, laneInput, db)
      } catch (error) {
        vectorHealth = 'unavailable'
        vectorDetail = 'Vector search unavailable'
        log.warn('solutions_retrieval_vector_failed', { lane, error: error instanceof Error ? error.message : String(error) })
        metrics.increment('solutionsRetrievalVectorFailures')
      }
    }

    const keys = dedupeKeys([...lexicalHits, ...vectorHits])
    const candidates = await loadCandidates(keys, db)
    const scored = fuseAndScore(
      candidates.map((row) => ({ ...row, maxEvidenceLevel: row.maxEvidenceLevel as ScoredCandidate['maxEvidenceLevel'] })),
      { lexical: lexicalHits, vector: vectorHits },
      now,
    )
    const outcome = diversify(scored, {
      maxPerSource: MAX_PER_SOURCE,
      maxPerKind: MAX_PER_KIND,
      limit: options.perLane ?? DEFAULT_LANE_RESULTS,
    })

    byLane[lane] = outcome.results
    laneTraces.push({
      lane,
      kinds,
      lexicalHits: lexicalHits.length,
      vectorHits: vectorHits.length,
      candidates: candidates.length,
      returned: outcome.results.length,
      suppressedBySource: outcome.suppressedBySource,
      suppressedByKind: outcome.suppressedByKind,
    })
  }

  const trace: RetrievalTrace = {
    queryHash: hashRetrievalQuery(brief, filters),
    lexical: lexicalHealth,
    vector: vectorHealth,
    ...(vectorDetail ? { vectorDetail } : {}),
    ...(lexicalDetail ? { lexicalDetail } : {}),
    filters,
    lanes: laneTraces,
    durationMs: Date.now() - started,
    rerankerApplied: false,
  }

  log.info('solutions_retrieval', {
    queryHash: trace.queryHash,
    lexical: lexicalHealth,
    vector: vectorHealth,
    returned: laneTraces.reduce((sum, lane) => sum + lane.returned, 0),
    durationMs: trace.durationMs,
  })
  return { byLane, trace }
}

/**
 * Identifies a retrieval by what determines its results.
 *
 * The brief's *retrieval-relevant* fields and the derived filters — not the whole brief. Budget and
 * deadline change which routes the composer will offer but not which components retrieval finds, so
 * including them would make two runs over the same candidate set look like different retrievals and defeat
 * the point of a reproducible hash.
 */
export function hashRetrievalQuery(brief: SolutionBrief, filters: RetrievalFilters): string {
  return createHash('sha256')
    .update(canonicalJson({
      description: brief.deliverable.description,
      domain: brief.deliverable.domain,
      capabilities: [...brief.capabilities].sort(),
      languages: [...brief.languages].sort(),
      filters: {
        capabilityKeys: [...filters.capabilityKeys].sort(),
        requiredCapabilityKeys: [...filters.requiredCapabilityKeys].sort(),
        excludedComponentIds: [...filters.excludedComponentIds].sort(),
      },
    }))
    .digest('hex')
}

function dedupeKeys(hits: readonly LaneHit[]): Array<{ componentId: string; version: number }> {
  const seen = new Set<string>()
  const keys: Array<{ componentId: string; version: number }> = []
  for (const hit of hits) {
    const key = `${hit.componentId}:${hit.version}`
    if (seen.has(key)) continue
    seen.add(key)
    keys.push({ componentId: hit.componentId, version: hit.version })
  }
  return keys
}
