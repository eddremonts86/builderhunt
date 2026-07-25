// Code-style fingerprint generation. Pure — no LLM, no network, no I/O
// imports, so both server code and client components can import it.
//
// v1: heuristic from builder metadata (frozen; `generateFingerprint` below).
// v2: AI-analyzed from real repo samples — produced by the `fingerprint-v2`
// task and persisted at `builders.metadata.codeStyleFingerprint`. The v2
// schema lives here rather than next to the task because the profile card
// (a client component) has to validate stored envelopes too.
import { z } from 'zod'

export type Paradigm = 'functional' | 'oop' | 'pragmatic'

export interface CodeStyleFingerprint {
  paradigm: Paradigm
  modularityScore: number
  testIntensity: number
  documentationRatio: number
  complexityControl: number
  namingConsistency: number
  language: string | null
  generatedAt: number
}

const FP_LANGS: Record<string, Partial<CodeStyleFingerprint>> = {
  rust: { paradigm: 'functional', modularityScore: 88, complexityControl: 90, documentationRatio: 75, namingConsistency: 92, testIntensity: 78 },
  haskell: { paradigm: 'functional', modularityScore: 90, complexityControl: 85, documentationRatio: 70, namingConsistency: 88, testIntensity: 80 },
  elixir: { paradigm: 'functional', modularityScore: 82, complexityControl: 80, documentationRatio: 72, namingConsistency: 85, testIntensity: 82 },
  typescript: { paradigm: 'pragmatic', modularityScore: 78, complexityControl: 75, documentationRatio: 70, namingConsistency: 82, testIntensity: 72 },
  javascript: { paradigm: 'pragmatic', modularityScore: 65, complexityControl: 60, documentationRatio: 50, namingConsistency: 70, testIntensity: 50 },
  python: { paradigm: 'pragmatic', modularityScore: 72, complexityControl: 70, documentationRatio: 65, namingConsistency: 75, testIntensity: 68 },
  go: { paradigm: 'pragmatic', modularityScore: 80, complexityControl: 78, documentationRatio: 65, namingConsistency: 85, testIntensity: 75 },
  java: { paradigm: 'oop', modularityScore: 75, complexityControl: 70, documentationRatio: 78, namingConsistency: 85, testIntensity: 78 },
  kotlin: { paradigm: 'oop', modularityScore: 78, complexityControl: 75, documentationRatio: 72, namingConsistency: 82, testIntensity: 75 },
  swift: { paradigm: 'oop', modularityScore: 76, complexityControl: 75, documentationRatio: 68, namingConsistency: 80, testIntensity: 70 },
  ruby: { paradigm: 'oop', modularityScore: 70, complexityControl: 65, documentationRatio: 60, namingConsistency: 72, testIntensity: 75 },
  csharp: { paradigm: 'oop', modularityScore: 73, complexityControl: 70, documentationRatio: 70, namingConsistency: 80, testIntensity: 72 },
  cpp: { paradigm: 'oop', modularityScore: 65, complexityControl: 60, documentationRatio: 55, namingConsistency: 70, testIntensity: 55 },
  c: { paradigm: 'pragmatic', modularityScore: 60, complexityControl: 55, documentationRatio: 45, namingConsistency: 68, testIntensity: 45 },
}

const DEFAULT_FP: Omit<CodeStyleFingerprint, 'language' | 'generatedAt'> = {
  paradigm: 'pragmatic',
  modularityScore: 65,
  complexityControl: 65,
  documentationRatio: 60,
  namingConsistency: 72,
  testIntensity: 60,
}

const FUNCTIONAL_TOPICS = ['async', 'functional', 'reactive', 'elixir', 'haskell', 'rust', 'lisp', 'clojure']
const OOP_TOPICS = ['oop', 'object-oriented', 'design-patterns', 'spring', 'java', 'kotlin', 'dotnet', 'rails']

export function generateFingerprint(builder: {
  language?: string | null
  topics?: string[]
  followersCount?: number
  metadata?: Record<string, unknown>
}): CodeStyleFingerprint {
  const lang = (builder.language ?? '').toLowerCase().trim()
  const base = lang && FP_LANGS[lang] ? { ...DEFAULT_FP, ...FP_LANGS[lang] } : { ...DEFAULT_FP }

  // Bias by topic if language is missing
  if (!lang) {
    const topicsLower = (builder.topics ?? []).map((t) => t.toLowerCase())
    if (topicsLower.some((t) => FUNCTIONAL_TOPICS.some((f) => t.includes(f)))) {
      base.paradigm = 'functional'
    } else if (topicsLower.some((t) => OOP_TOPICS.some((o) => t.includes(o)))) {
      base.paradigm = 'oop'
    }
  }

  // Boost scores for builders with many followers (correlates with quality)
  const followers = builder.followersCount ?? 0
  if (followers > 1000) {
    base.namingConsistency = Math.min(100, base.namingConsistency + 5)
    base.documentationRatio = Math.min(100, base.documentationRatio + 5)
  }

  return {
    ...base,
    language: builder.language ?? null,
    generatedAt: Date.now(),
  }
}

/**
 * Compute similarity between two fingerprints (0-100).
 * Closer = more similar coding styles. Weighted Euclidean distance
 * across the 5 metrics + paradigm match bonus.
 */
export function similarity(a: CodeStyleFingerprint, b: CodeStyleFingerprint): number {
  const metrics: Array<keyof Omit<CodeStyleFingerprint, 'paradigm' | 'language' | 'generatedAt'>> = [
    'modularityScore',
    'testIntensity',
    'documentationRatio',
    'complexityControl',
    'namingConsistency',
  ]
  let sumDiff = 0
  for (const m of metrics) {
    const diff = Math.abs(a[m] - b[m])
    sumDiff += diff
  }
  const avgDiff = sumDiff / metrics.length
  const metricSim = Math.max(0, 100 - avgDiff)

  // Paradigm match: same paradigm = +0, different = -15
  const paradigmPenalty = a.paradigm === b.paradigm ? 0 : 15
  // Language match: same language = +5
  const langBonus = a.language && a.language === b.language ? 5 : 0

  return Math.max(0, Math.min(100, metricSim - paradigmPenalty + langBonus))
}

// ---------------------------------------------------------------------------
// v2 — AI-analyzed fingerprint (plan: code-fingerprinting)
// ---------------------------------------------------------------------------

/** What the model returns. Metric names match `CodeStyleFingerprint` exactly so
 *  `similarity()` and `CodeStyleCard` keep working across v1 and v2. */
export const codeStyleFingerprintModelSchema = z.object({
  paradigm: z.enum(['functional', 'oop', 'pragmatic']),
  modularityScore: z.number().int().min(0).max(100),
  testIntensity: z.number().int().min(0).max(100),
  documentationRatio: z.number().int().min(0).max(100),
  complexityControl: z.number().int().min(0).max(100),
  namingConsistency: z.number().int().min(0).max(100),
  evidence: z.array(z.string().min(3).max(160)).min(1).max(6),
})
export type CodeStyleFingerprintModel = z.infer<typeof codeStyleFingerprintModelSchema>

/**
 * The stored envelope at `builders.metadata.codeStyleFingerprint`.
 *
 * `code-fingerprinting` owns this key. An earlier placeholder in `synergy.ts`
 * used a nested `{ version, metrics, generatedAt }` shape while this plan was
 * unshipped; that shape never had a writer, and keeping both would have meant
 * every synergy `safeParse` silently failing against real data and falling
 * back to the v1 heuristic forever. This flat shape is now the only one.
 */
export const codeStyleFingerprintV2Schema = codeStyleFingerprintModelSchema.extend({
  language: z.string().nullable(),
  analyzedRepos: z.array(z.string()),
  analyzedFiles: z.number().int(),
  analyzedAt: z.string().datetime(),
  model: z.string(),
  version: z.literal(2),
})
export type CodeStyleFingerprintV2 = z.infer<typeof codeStyleFingerprintV2Schema>

/** Adapts a stored v2 envelope to the shape `similarity()` compares. */
export function fingerprintFromV2(v2: CodeStyleFingerprintV2): CodeStyleFingerprint {
  return {
    paradigm: v2.paradigm,
    modularityScore: v2.modularityScore,
    testIntensity: v2.testIntensity,
    documentationRatio: v2.documentationRatio,
    complexityControl: v2.complexityControl,
    namingConsistency: v2.namingConsistency,
    language: v2.language,
    generatedAt: Date.parse(v2.analyzedAt) || 0,
  }
}
