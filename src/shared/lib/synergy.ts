/**
 * Team Synergy — candidate-vs-team fit analysis (plan: team-synergy).
 *
 * Pure library: team aggregation and the deterministic baseline score, both
 * computed in-memory over already-fetched rows — no I/O here. The AI task
 * itself is registered in `~/shared/lib/ai/tasks.ts`, importing the schemas
 * below (mirrors `enrichment.ts`'s split between schema/pure-logic module
 * and task registration).
 *
 * `codeStyleFingerprintV2Schema` is defined here, not in `code-style.ts`,
 * because no plan has shipped the v2 (AI-analyzed) fingerprint yet —
 * `code-fingerprinting`'s v2 phase is still pending. Every stored
 * `privateMetadata.codeStyleFingerprint` will therefore fail this
 * `safeParse` until that plan lands, and `buildTeamAggregate` falls back to
 * `generateFingerprint` (v1 heuristic) for every member — exactly the "soft
 * dependency" the spec describes.
 */
import { z } from 'zod'
import {
  codeStyleFingerprintV2Schema as storedFingerprintSchema,
  fingerprintFromV2,
  generateFingerprint,
  type CodeStyleFingerprint,
  type Paradigm,
} from './code-style'

export const codeStyleMetricsSchema = z.object({
  paradigm: z.enum(['functional', 'oop', 'pragmatic']),
  modularityScore: z.number().min(0).max(100),
  testIntensity: z.number().min(0).max(100),
  documentationRatio: z.number().min(0).max(100),
  complexityControl: z.number().min(0).max(100),
  namingConsistency: z.number().min(0).max(100),
})
export type CodeStyleMetrics = z.infer<typeof codeStyleMetricsSchema>

// The v2 envelope now has a real writer (`code-fingerprinting`'s
// `fingerprint-v2` task), and that plan owns the metadata key — so the
// canonical schema lives in `code-style.ts` next to v1 and is re-exported
// here for the callers that already import it from this module. The former
// local placeholder used a nested `{ version, metrics, generatedAt }` shape
// that nothing ever wrote; matching real stored data is what makes team
// synergy actually pick up AI fingerprints instead of silently falling back
// to the v1 heuristic on every parse.
export {
  codeStyleFingerprintV2Schema,
  type CodeStyleFingerprintV2,
} from './code-style'

const SENIORITY_VALUES = ['junior', 'mid', 'senior', 'lead'] as const
type Seniority = (typeof SENIORITY_VALUES)[number]

export interface TeamMemberRow {
  language?: string | null
  topics?: string[]
  followersCount?: number | null
  privateMetadata?: Record<string, unknown> | null
}

export interface TeamAggregate {
  size: number
  languages: { name: string; share: number }[]
  topTopics: string[]
  paradigms: Partial<Record<Paradigm, number>>
  metricMeans: Omit<CodeStyleMetrics, 'paradigm'>
  seniorityMix: Partial<Record<Seniority, number>> | null
  aiFingerprintShare: number
}

const MAX_TEAM_SIZE = 50
const METRIC_KEYS = [
  'modularityScore',
  'testIntensity',
  'documentationRatio',
  'complexityControl',
  'namingConsistency',
] as const

function toMetrics(fp: CodeStyleFingerprint): CodeStyleMetrics {
  return {
    paradigm: fp.paradigm,
    modularityScore: fp.modularityScore,
    testIntensity: fp.testIntensity,
    documentationRatio: fp.documentationRatio,
    complexityControl: fp.complexityControl,
    namingConsistency: fp.namingConsistency,
  }
}

/**
 * Aggregates up to 50 team member rows into the shape the `synergy-analysis`
 * AI task consumes. Per member: a stored, schema-valid v2 fingerprint if
 * present, else the v1 heuristic (`generateFingerprint`). Caller is
 * responsible for excluding the candidate being analyzed from `rows` first.
 */
export function buildTeamAggregate(rows: TeamMemberRow[]): TeamAggregate {
  const capped = rows.slice(0, MAX_TEAM_SIZE)
  const size = capped.length

  const fingerprints = capped.map((row) => {
    const stored = storedFingerprintSchema.safeParse(
      (row.privateMetadata as Record<string, unknown> | undefined)?.codeStyleFingerprint,
    )
    if (stored.success) return { metrics: toMetrics(fingerprintFromV2(stored.data)), source: 'ai' as const }
    return {
      metrics: toMetrics(generateFingerprint({
        language: row.language,
        topics: row.topics,
        followersCount: row.followersCount ?? undefined,
      })),
      source: 'heuristic' as const,
    }
  })

  const langCounts = new Map<string, number>()
  for (const row of capped) {
    const lang = row.language?.trim()
    if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1)
  }
  const languages = [...langCounts.entries()]
    .map(([name, count]) => ({ name, share: size > 0 ? count / size : 0 }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 8)

  const topicCounts = new Map<string, number>()
  for (const row of capped) {
    for (const topic of row.topics ?? []) {
      const normalized = topic.trim().toLowerCase()
      if (normalized) topicCounts.set(normalized, (topicCounts.get(normalized) ?? 0) + 1)
    }
  }
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([topic]) => topic)

  const paradigmCounts: Partial<Record<Paradigm, number>> = {}
  for (const fp of fingerprints) {
    paradigmCounts[fp.metrics.paradigm] = (paradigmCounts[fp.metrics.paradigm] ?? 0) + 1
  }
  const paradigms: Partial<Record<Paradigm, number>> = {}
  for (const [paradigm, paradigmCount] of Object.entries(paradigmCounts)) {
    paradigms[paradigm as Paradigm] = size > 0 ? paradigmCount / size : 0
  }

  const metricMeans = Object.fromEntries(METRIC_KEYS.map((key) => {
    const sum = fingerprints.reduce((acc, fp) => acc + fp.metrics[key], 0)
    return [key, size > 0 ? Math.round(sum / size) : 0]
  })) as Omit<CodeStyleMetrics, 'paradigm'>

  const seniorityCounts: Partial<Record<Seniority, number>> = {}
  let enrichedCount = 0
  for (const row of capped) {
    const enrichment = (row.privateMetadata as Record<string, unknown> | undefined)?.aiEnrichment as
      | { estimatedSeniority?: string }
      | undefined
    const seniority = enrichment?.estimatedSeniority
    if (seniority && (SENIORITY_VALUES as readonly string[]).includes(seniority)) {
      enrichedCount += 1
      const key = seniority as Seniority
      seniorityCounts[key] = (seniorityCounts[key] ?? 0) + 1
    }
  }
  const seniorityMix = enrichedCount >= 3
    ? Object.fromEntries(Object.entries(seniorityCounts).map(([tier, tierCount]) => [tier, tierCount / enrichedCount]))
    : null

  const aiFingerprintShare = size > 0
    ? fingerprints.filter((fp) => fp.source === 'ai').length / size
    : 0

  return { size, languages, topTopics, paradigms, metricMeans, seniorityMix, aiFingerprintShare }
}

export interface SynergyCandidateInput {
  language?: string | null
  topics?: string[]
  fingerprint: CodeStyleMetrics
}

export interface SynergyBaseline {
  score: number
  notes: string[]
}

/**
 * Deterministic candidate-vs-team fit score, per spec: language bridge
 * (+20), complementary-metric gap-filling (up to +40, scaled by gap size —
 * this scaling is what keeps the score monotonic in gap size, the property
 * `synergy.test.ts` checks directly), paradigm fit (+10 majority / +20
 * minority-but-present / 0 + friction note if absent), topic Jaccard overlap
 * (up to +20). Clamped 0–100. Also the graceful-degradation fallback when
 * the AI call fails — never a dead button.
 */
export function computeSynergyBaseline(candidate: SynergyCandidateInput, team: TeamAggregate): SynergyBaseline {
  let score = 0
  const notes: string[] = []

  if (candidate.language) {
    const languageLower = candidate.language.toLowerCase()
    const match = team.languages.find((entry) => entry.name.toLowerCase() === languageLower)
    if (match && match.share >= 0.2) {
      score += 20
      notes.push(`Shares ${candidate.language} with ${Math.round(match.share * 100)}% of the team`)
    }
  }

  let bestGapContribution = 0
  let bestGapMetric: (typeof METRIC_KEYS)[number] | null = null
  for (const key of METRIC_KEYS) {
    const gap = candidate.fingerprint[key] - team.metricMeans[key]
    if (gap <= 0) continue
    const contribution = Math.min(40, gap * 0.4)
    if (contribution > bestGapContribution) {
      bestGapContribution = contribution
      bestGapMetric = key
    }
  }
  if (bestGapMetric) {
    score += bestGapContribution
    notes.push(`Strong ${humanizeMetric(bestGapMetric)} fills a gap in the team's current strengths`)
  }

  const paradigmShare = team.paradigms[candidate.fingerprint.paradigm] ?? 0
  if (paradigmShare > 0.5) {
    score += 10
    notes.push(`Fits the team's dominant ${candidate.fingerprint.paradigm} paradigm`)
  } else if (paradigmShare > 0) {
    score += 20
    notes.push(`Brings a ${candidate.fingerprint.paradigm} perspective the team mostly lacks — healthy diversity`)
  } else if (team.size > 0) {
    notes.push(`No one on the team shares a ${candidate.fingerprint.paradigm} style — possible friction`)
  }

  const candidateTopics = new Set((candidate.topics ?? []).map((topic) => topic.trim().toLowerCase()).filter(Boolean))
  const teamTopics = new Set(team.topTopics)
  if (candidateTopics.size > 0 && teamTopics.size > 0) {
    const intersectionSize = [...candidateTopics].filter((topic) => teamTopics.has(topic)).length
    const unionSize = new Set([...candidateTopics, ...teamTopics]).size
    const jaccard = unionSize > 0 ? intersectionSize / unionSize : 0
    const topicScore = Math.round(jaccard * 20)
    if (topicScore > 0) {
      score += topicScore
      notes.push('Overlaps with the team\'s current focus areas')
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    notes: notes.slice(0, 6),
  }
}

function humanizeMetric(key: (typeof METRIC_KEYS)[number]): string {
  switch (key) {
    case 'modularityScore': return 'modularity'
    case 'testIntensity': return 'test coverage'
    case 'documentationRatio': return 'documentation'
    case 'complexityControl': return 'complexity control'
    case 'namingConsistency': return 'naming consistency'
  }
}

// ---------------------------------------------------------------------------
// `synergy-analysis` AI task schemas (registered in ~/shared/lib/ai/tasks.ts)
// ---------------------------------------------------------------------------

export const synergyEnrichmentSchema = z.object({
  estimatedSeniority: z.enum(SENIORITY_VALUES),
  primaryFocus: z.string(),
  strengths: z.array(z.string()).max(6),
})
export type SynergyEnrichment = z.infer<typeof synergyEnrichmentSchema>

export const synergyInputSchema = z.object({
  candidate: z.object({
    username: z.string(),
    source: z.string(),
    bio: z.string().max(1000).nullish(),
    topics: z.array(z.string()).max(20),
    language: z.string().nullish(),
    followersCount: z.number().nullish(),
    fingerprint: codeStyleMetricsSchema,
    fingerprintSource: z.enum(['ai', 'heuristic']),
    enrichment: synergyEnrichmentSchema.nullish(),
  }),
  team: z.object({
    size: z.number().int().min(2).max(50),
    languages: z.array(z.object({ name: z.string(), share: z.number() })).max(8),
    topTopics: z.array(z.string()).max(15),
    // Modeled as an object of optional fields, not `z.record(enumSchema, ...)`
    // — zod infers a record over a finite enum key as fully required, but the
    // aggregate only ever reports the paradigms/seniority tiers actually
    // present in the team (see `buildTeamAggregate`).
    paradigms: z.object({
      functional: z.number().optional(),
      oop: z.number().optional(),
      pragmatic: z.number().optional(),
    }),
    metricMeans: codeStyleMetricsSchema.omit({ paradigm: true }),
    seniorityMix: z.object({
      junior: z.number().optional(),
      mid: z.number().optional(),
      senior: z.number().optional(),
      lead: z.number().optional(),
    }).nullish(),
    aiFingerprintShare: z.number().min(0).max(1),
  }),
  baseline: z.object({
    score: z.number().int().min(0).max(100),
    notes: z.array(z.string()).max(6),
  }),
})
export type SynergyInput = z.infer<typeof synergyInputSchema>

export const synergyOutputSchema = z.object({
  synergyScore: z.number().int().min(0).max(100),
  summary: z.string().min(40).max(500),
  complementaryStrengths: z.array(z.string().min(3).max(140)).min(1).max(5),
  overlaps: z.array(z.string().min(3).max(140)).max(5),
  frictionPoints: z.array(z.string().min(3).max(160)).max(4),
  confidence: z.enum(['low', 'medium', 'high']),
})
export type SynergyOutput = z.infer<typeof synergyOutputSchema>
