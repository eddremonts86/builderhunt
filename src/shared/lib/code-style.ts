// Code-style fingerprint generation. Pure function — no LLM, no network.
// v1: heuristic from builder metadata. v2: would call an LLM with
// real repo samples.

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
