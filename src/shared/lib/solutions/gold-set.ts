/**
 * The gold set's contract and its scoring (plan 43 Phase 0, "Create the synthetic gold set, its CRUD, and the
 * baseline report").
 *
 * Pure: schemas and arithmetic, no I/O. The evaluator script does the reading and the running; this module is
 * what makes the evaluator's numbers reproducible and testable without a database.
 *
 * ## Why `authorship` is on every record and in every report
 *
 * The 60 seeded briefs are machine-authored. The generator and the grader share assumptions, so a score against
 * them is circular — it detects regressions and proves nothing about quality. tasks.md is explicit that a
 * synthetic-only run "must never print an unqualified quality number", so `authorship` is a required field, the
 * report separates the two populations, and `summarize` refuses to produce a combined score at all.
 */
import { z } from 'zod'
import { BRIEF_DOMAINS, RANKING_MODES, ROUTE_TYPES, hardConstraintSchema } from './contracts'

export const GOLD_AUTHORSHIPS = ['synthetic', 'human'] as const
export type GoldAuthorship = (typeof GOLD_AUTHORSHIPS)[number]

export const goldBriefSchema = z.object({
  id: z.string().min(1).max(80),
  authorship: z.enum(GOLD_AUTHORSHIPS),
  /** The brief as a user would type it. Interpretation is part of what is being measured. */
  briefText: z.string().min(1).max(4000),
  expected: z.object({
    domain: z.enum(BRIEF_DOMAINS),
    capabilityKeys: z.array(z.string().min(1).max(80)).min(1).max(10),
    /** Which lanes a competent recommender should be able to offer at all. */
    offerableLanes: z.array(z.enum(ROUTE_TYPES)).max(3),
    hardConstraints: z.array(hardConstraintSchema).max(20),
    /** Components that must never appear — a job posting is not someone who can do the work. */
    unacceptableComponentKinds: z.array(z.string().min(1).max(80)).max(10).default([]),
    rankingMode: z.enum(RANKING_MODES),
    scaleMagnitude: z.enum(['one_off', 'small', 'medium', 'large']).optional(),
  }).strict(),
}).strict()
export type GoldBrief = z.infer<typeof goldBriefSchema>

export const goldSetFileSchema = z.object({
  version: z.number().int().positive(),
  generatedBy: z.string().min(1),
  authorshipNote: z.string().min(1),
  briefs: z.array(goldBriefSchema).min(1),
}).strict()

/** What one brief's run produced, reduced to the facts the judgment compares against. */
export interface GoldObservation {
  briefId: string
  interpretedCapabilityKeys: string[]
  interpretedDomain: string
  offeredLanes: string[]
  /** Constraints the interpretation kept, after the quote check. */
  keptConstraintTypes: string[]
  /** Component kinds that appeared in any offered route. */
  componentKinds: string[]
  latencyMs: number
  providerCalls: number
}

export interface GoldScore {
  briefId: string
  authorship: GoldAuthorship
  /** Fraction of expected capabilities the interpretation found. */
  capabilityRecall: number
  domainCorrect: boolean
  /** Fraction of expected lanes actually offered. */
  laneRecall: number
  /** Fraction of expected hard constraints that survived interpretation. */
  constraintRetention: number
  /** True when nothing unacceptable appeared. A single violation is a failure, not a fraction. */
  respectedExclusions: boolean
  latencyMs: number
  providerCalls: number
}

export function scoreBrief(brief: GoldBrief, observation: GoldObservation): GoldScore {
  const expectedCaps = new Set(brief.expected.capabilityKeys)
  const foundCaps = observation.interpretedCapabilityKeys.filter((key) => expectedCaps.has(key))
  const expectedLanes = new Set<string>(brief.expected.offerableLanes)
  const foundLanes = observation.offeredLanes.filter((lane) => expectedLanes.has(lane))
  const expectedConstraints = brief.expected.hardConstraints.map((constraint) => constraint.type)
  const keptConstraints = expectedConstraints.filter((type) => observation.keptConstraintTypes.includes(type))

  return {
    briefId: brief.id,
    authorship: brief.authorship,
    capabilityRecall: ratio(foundCaps.length, expectedCaps.size),
    domainCorrect: observation.interpretedDomain === brief.expected.domain,
    laneRecall: ratio(foundLanes.length, expectedLanes.size),
    constraintRetention: ratio(keptConstraints.length, expectedConstraints.length),
    // Any appearance of an excluded kind fails the brief outright. Averaging it would let a recommender that
    // surfaced a job posting in one route out of sixty still look 98% clean.
    respectedExclusions: !brief.expected.unacceptableComponentKinds.some((kind) =>
      observation.componentKinds.some((actual) => actual === kind || actual === kind.split(':')[0])),
    latencyMs: observation.latencyMs,
    providerCalls: observation.providerCalls,
  }
}

/** An empty expectation scores 1: nothing was required and nothing was missed. */
function ratio(found: number, expected: number): number {
  return expected === 0 ? 1 : found / expected
}

export interface GoldSummary {
  authorship: GoldAuthorship
  count: number
  capabilityRecall: Interval
  laneRecall: Interval
  constraintRetention: Interval
  domainAccuracy: Interval
  exclusionFailures: number
  latencyP50Ms: number
  latencyP95Ms: number
  providerCallsTotal: number
}

export interface Interval {
  mean: number
  /** 95% normal-approximation half-width. Reported so a 12-brief segment is visibly less certain than a 60. */
  halfWidth: number
}

/**
 * Summarises one authorship population.
 *
 * Deliberately per-population and never combined. tasks.md: only human-authored judgments may be cited as a
 * quality gate, and a single blended number is exactly the thing that gets quoted without its caveat.
 */
export function summarize(scores: readonly GoldScore[], authorship: GoldAuthorship): GoldSummary | null {
  const population = scores.filter((score) => score.authorship === authorship)
  if (population.length === 0) return null

  const latencies = population.map((score) => score.latencyMs).sort((a, b) => a - b)
  return {
    authorship,
    count: population.length,
    capabilityRecall: interval(population.map((score) => score.capabilityRecall)),
    laneRecall: interval(population.map((score) => score.laneRecall)),
    constraintRetention: interval(population.map((score) => score.constraintRetention)),
    domainAccuracy: interval(population.map((score) => (score.domainCorrect ? 1 : 0))),
    exclusionFailures: population.filter((score) => !score.respectedExclusions).length,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    providerCallsTotal: population.reduce((total, score) => total + score.providerCalls, 0),
  }
}

export function interval(values: readonly number[]): Interval {
  if (values.length === 0) return { mean: 0, halfWidth: 0 }
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  if (values.length === 1) return { mean, halfWidth: 0 }
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1)
  return { mean, halfWidth: 1.96 * Math.sqrt(variance / values.length) }
}

/** Nearest-rank, so a reported p95 is always a latency some run actually had. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1]
}

/**
 * Whether a report may be cited as a quality gate.
 *
 * The one rule the whole authorship split exists to enforce, expressed as a function so the evaluator and any
 * future dashboard cannot each decide it differently.
 */
export function isCitableAsQualityGate(summaries: ReadonlyArray<GoldSummary | null>): boolean {
  const human = summaries.find((summary) => summary?.authorship === 'human')
  return Boolean(human && human.count > 0)
}
