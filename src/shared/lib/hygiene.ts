// Project Hygiene computation. Pure function — no DB, no network.
// In v1 we compute from existing builder metadata; Phase 2
// (~/lib/github/repo-signals.ts) fetches real GitHub issues/PRs/files data
// per repo for GitHub builders.
import { z } from 'zod'

export interface ProjectHygiene {
  globalScore: number // 0-100
  issueCloseRate: number // 0-100
  averageResolutionDays: number
  hasCICD: boolean
  documentationScore: number // 0-100
  lastAnalyzedAt: number
}

export interface RepoSignals {
  name: string
  stars: number
  openIssues: number
  closedIssues: number
  hasReadme: boolean
  hasContributing: boolean
  hasLicense: boolean
  hasWorkflows: boolean
  averageCloseDays: number
  pushedAt: number
}

const EMPTY_HYGIENE: ProjectHygiene = {
  globalScore: 0,
  issueCloseRate: 0,
  averageResolutionDays: 0,
  hasCICD: false,
  documentationScore: 0,
  lastAnalyzedAt: 0,
}

/**
 * Compute project hygiene from a set of repo signals.
 * Global score weights: issue close rate 30%, PR resolution 30%,
 * documentation 20%, CI/CD 20%.
 */
export function computeHygiene(repos: RepoSignals[]): ProjectHygiene {
  if (!repos || repos.length === 0) return EMPTY_HYGIENE

  // Issue close rate (across all repos)
  const totalOpen = repos.reduce((s, r) => s + r.openIssues, 0)
  const totalClosed = repos.reduce((s, r) => s + r.closedIssues, 0)
  const totalAll = totalOpen + totalClosed
  const issueCloseRate = totalAll === 0 ? 100 : Math.round((totalClosed / totalAll) * 100)

  // Average resolution days (weighted by issue count per repo)
  const reposWithClose = repos.filter((r) => r.averageCloseDays > 0)
  const averageResolutionDays =
    reposWithClose.length === 0
      ? 0
      : Math.round(
          reposWithClose.reduce((s, r) => s + r.averageCloseDays, 0) / reposWithClose.length,
        )

  // Documentation score: % of repos with all three (readme, contributing, license)
  const docCount = repos.filter((r) => r.hasReadme && r.hasContributing && r.hasLicense).length
  const documentationScore = Math.round((docCount / repos.length) * 100)

  // CI/CD: any repo with workflows
  const hasCICD = repos.some((r) => r.hasWorkflows)

  // Global score
  // PR resolution = max(0, 100 - avgDays * 2) — 0 days = 100, 50 days = 0
  const prResolutionScore =
    averageResolutionDays === 0 ? 100 : Math.max(0, 100 - averageResolutionDays * 2)

  const cicdScore = hasCICD ? 100 : 0

  const globalScore = Math.round(
    issueCloseRate * 0.3 +
      prResolutionScore * 0.3 +
      documentationScore * 0.2 +
      cicdScore * 0.2,
  )

  return {
    globalScore: Math.max(0, Math.min(100, globalScore)),
    issueCloseRate,
    averageResolutionDays,
    hasCICD,
    documentationScore,
    lastAnalyzedAt: Date.now(),
  }
}

/**
 * Small stable string hash (djb2 variant) so the same (username, repoName)
 * pair always produces the same estimated signals — `Math.random()` made
 * every render/reload show different fake numbers for the same builder,
 * which reads as broken rather than "estimated."
 */
function stableHash(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i)
  }
  return Math.abs(hash)
}

/** Deterministic pseudo-random int in `[min, max)`, seeded by `seed`. */
function seededRange(seed: string, min: number, max: number): number {
  const h = stableHash(seed)
  return min + (h % Math.max(1, max - min))
}

/**
 * Generate plausible repo signals from a builder's existing metadata
 * (followers, topics, language). Heuristic — used for v1 until we wire
 * real GitHub API per-repo scans.
 */
export function estimateRepoSignalsFromBuilder(builder: {
  username?: string
  followersCount?: number
  topics?: string[]
  language?: string | null
  metadata?: Record<string, unknown>
}): RepoSignals[] {
  // Try to use real repo data from metadata if present
  const meta = (builder.metadata ?? {}) as {
    repos?: Array<{
      name: string
      stars?: number
      openIssues?: number
      closedIssues?: number
      hasReadme?: boolean
      hasContributing?: boolean
      hasLicense?: boolean
      hasWorkflows?: boolean
      averageCloseDays?: number
      pushedAt?: number
    }>
  }
  if (Array.isArray(meta.repos) && meta.repos.length > 0) {
    return meta.repos.map((r) => ({
      name: r.name,
      stars: r.stars ?? 0,
      openIssues: r.openIssues ?? 0,
      closedIssues: r.closedIssues ?? 0,
      hasReadme: r.hasReadme ?? false,
      hasContributing: r.hasContributing ?? false,
      hasLicense: r.hasLicense ?? false,
      hasWorkflows: r.hasWorkflows ?? false,
      averageCloseDays: r.averageCloseDays ?? 0,
      pushedAt: r.pushedAt ?? Date.now(),
    }))
  }

  // Heuristic generation: produce 2-5 fake repos based on followers + topics
  const followers = builder.followersCount ?? 0
  const topics = builder.topics ?? []
  const isHot = followers > 1000
  const numRepos = isHot ? 5 : 2

  const repoNames = [
    `${builder.language?.toLowerCase() ?? 'core'}-toolkit`,
    ...topics.slice(0, 3).map((t) => t.toLowerCase().replace(/\s+/g, '-')),
    'awesome-utils',
  ].filter(Boolean).slice(0, numRepos)

  const seedBase = `${builder.username ?? 'anonymous'}:${builder.language ?? ''}:${followers}`

  return repoNames.map((name, i) => {
    const stars = Math.max(10, followers - i * 200)
    const isPopular = stars > 500
    const seed = `${seedBase}:${name}`
    return {
      name,
      stars,
      openIssues: isPopular ? seededRange(seed + ':open', 5, 55) : seededRange(seed + ':open', 0, 5),
      closedIssues: isPopular ? seededRange(seed + ':closed', 50, 250) : seededRange(seed + ':closed', 0, 20),
      hasReadme: true,
      hasContributing: isPopular || i === 0,
      hasLicense: true,
      hasWorkflows: isPopular,
      averageCloseDays: isPopular ? seededRange(seed + ':days', 5, 35) : seededRange(seed + ':days', 0, 10),
      pushedAt: Date.now() - i * 7 * 24 * 60 * 60 * 1000,
    }
  })
}

export function hygieneGrade(score: number): { label: string; color: string } {
  if (score >= 85) return { label: 'Excellent', color: 'text-bh-success' }
  if (score >= 70) return { label: 'Good', color: 'text-bh-accent' }
  if (score >= 50) return { label: 'Average', color: 'text-bh-warning' }
  return { label: 'Needs work', color: 'text-bh-danger' }
}

// ---------------------------------------------------------------------------
// Persisted envelope (plan: project-hygiene, Phase 3) — what actually gets
// written to `organization_builders.privateMetadata.projectHygiene`. `version`
// is a literal so a future incompatible shape change can be detected on read
// rather than silently misinterpreted.
// ---------------------------------------------------------------------------

export const repoSignalsSchema = z.object({
  name: z.string(),
  stars: z.number(),
  openIssues: z.number(),
  closedIssues: z.number(),
  hasReadme: z.boolean(),
  hasContributing: z.boolean(),
  hasLicense: z.boolean(),
  hasWorkflows: z.boolean(),
  averageCloseDays: z.number(),
  pushedAt: z.number(),
})

export const projectHygieneSchema = z.object({
  globalScore: z.number(),
  issueCloseRate: z.number(),
  averageResolutionDays: z.number(),
  hasCICD: z.boolean(),
  documentationScore: z.number(),
  lastAnalyzedAt: z.number(),
})

export const projectHygieneEnvelopeSchema = z.object({
  hygiene: projectHygieneSchema,
  signals: z.array(repoSignalsSchema).max(5),
  computedAt: z.string(), // ISO date
  version: z.literal(1),
})

export type ProjectHygieneEnvelope = z.infer<typeof projectHygieneEnvelopeSchema>
