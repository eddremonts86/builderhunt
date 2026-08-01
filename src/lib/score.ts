import type { RawBuilder } from '~/lib/sources/types'

interface ScoredBuilder extends RawBuilder {
  score: number
}

/**
 * Score each builder / repo on a 0-100 scale.
 *
 * Composition (caps shown):
 *  - Popularity (log of followers/stargazers): up to 30 pts
 *  - Recency (last activity): up to 30 pts
 *  - Topic match (number of topics): up to 15 pts
 *  - Quality metadata (bio, avatar, profile): up to 10 pts
 *  - Community activity (Reddit active users, HN karma, etc.): up to 15 pts
 *
 * Final score is clamped to 0..100 and rounded to an integer.
 */
export function scoreBuilders(builders: RawBuilder[]): ScoredBuilder[] {
  const now = Date.now()

  return builders.map(builder => {
    const metadata = builder.metadata ?? {}
    const source = builder.source
    let score = 0

    // ---------- Popularity (0-30 pts) ----------
    // Logarithmic so a 100k-follower account doesn't drown a 1k one.
    // followersCount holds either user followers (GitHub users) or
    // stargazer count (GitHub repos) depending on `kind`.
    const followers = builder.followersCount ?? 0
    score += Math.log1p(followers) * 3.0 // 0-30 pts at log1p(10000)*3

    // ---------- Recency (0-30 pts) ----------
    // How recently was this builder / repo active?
    // For users: last commit / last post / last comment.
    // For repos: last push / last release.
    // Sources that don't expose `lastSeen` skip this branch.
    const lastSeen = (metadata.lastSeen as number | undefined) ?? null
    if (lastSeen !== null) {
      const daysSince = (now - lastSeen) / (1000 * 60 * 60 * 24)
      if (daysSince < 1) score += 30
      else if (daysSince < 7) score += 22
      else if (daysSince < 30) score += 12
      else if (daysSince < 90) score += 5
      else if (daysSince < 365) score += 1
      // else: 0 — old, not actively shipping
    } else {
      // No recency data — give a neutral 5 pts so we don't unfairly
      // rank these at 0 (HN / DEV.to / Reddit don't always expose it).
      score += 5
    }

    // ---------- Topics (0-15 pts) ----------
    // More topics = more match surface, but cap so spam doesn't dominate.
    const topicCount = builder.topics?.length ?? 0
    score += Math.min(topicCount * 2, 15)

    // ---------- Source-specific signals (0-15 pts) ----------
    if (source === 'github') {
      // Repo star count was already counted in `followers` (stargazers).
      // We use metadata.stars as a tiny tiebreaker for repos with very
      // recent activity to avoid double-counting.
      const stars = (metadata.stars as number | undefined) ?? 0
      if (stars > 0 && followers > 0) {
        // Only count the marginal effect (ratio, not raw).
        const ratio = stars / Math.max(followers, 1)
        if (ratio > 1.5) score += 4 // way more stars than watchers = strong signal
      }
    } else if (source === 'reddit') {
      const activeUsers = (metadata.activeUsers as number | undefined) ?? 0
      score += Math.log1p(activeUsers) * 1.5 // 0-15 pts
    } else if (source === 'hn') {
      const submitted = (metadata.submittedCount as number | undefined) ?? 0
      score += Math.log1p(submitted) * 1.2 // 0-15 pts
    } else if (source === 'devto') {
      const articles = (metadata.articlesCount as number | undefined) ?? 0
      score += Math.log1p(articles) * 1.5 // 0-15 pts
    } else if (source === 'lobsters') {
      // Lobsters has no followers/karma via JSON; use story count and
      // total score as quality signals. followersCount was already
      // populated with maxScore, so popularity is covered.
      const stories = (metadata.storyCount as number | undefined) ?? 0
      const totalScore = (metadata.totalScore as number | undefined) ?? 0
      score += Math.log1p(stories) * 1.5 // 0-15 pts based on activity
      // Bonus for high total story score (community quality proxy)
      if (totalScore > 100) score += 3
    } else if (source === 'stackoverflow') {
      // followersCount holds reputation; popularity is covered.
      // Boost for matching multiple keywords in top-answerers (multi-tag expert)
      const matched = (metadata.matchedTags as string[] | undefined) ?? []
      if (matched.length >= 2) score += 5
      if (matched.length >= 3) score += 5
      // Boost for high post count in the query's tag (high engagement)
      const postCount = (metadata.postCount as number | undefined) ?? 0
      score += Math.min(Math.log1p(postCount) * 1.5, 10)
    } else if (source === 'npm') {
      // For maintainers: totalScore is sum of package scores; packageCount
      // shows how broadly they're active. For packages: npms.io score
      // is already encoded in followersCount.
      const packageCount = (metadata.packageCount as number | undefined) ?? 0
      if (packageCount > 0) {
        // Multi-package maintainers get a small bonus
        score += Math.min(Math.log1p(packageCount) * 2, 8)
      }
    } else if (source === 'huggingface') {
      // For models: downloads is followersCount (already counted). For
      // authors: totalDownloads signals impact. Likes are quality signal.
      const totalDownloads = (metadata.totalDownloads as number | undefined) ?? 0
      if (totalDownloads > 0) {
        // Bonus scaled by log downloads, capped at 12
        score += Math.min(Math.log1p(totalDownloads) * 0.8, 12)
      }
    } else if (source === 'gitlab') {
      // No followers; followersCount holds totalStars. Bonus for forks
      // (people who depend on the code) and topic diversity.
      const totalForks = (metadata.totalForks as number | undefined) ?? 0
      if (totalForks > 0) score += Math.min(Math.log1p(totalForks) * 1.2, 8)
    } else if (source === 'codeberg') {
      // Gitea exposes full follower counts, so followersCount is honest.
      // Bonus for starred repos and forks (engagement signal).
      const stars = (metadata.stars as number | undefined) ?? 0
      const forks = (metadata.forks as number | undefined) ?? 0
      if (stars > 0) score += Math.min(Math.log1p(stars) * 1.0, 8)
      if (forks > 0) score += Math.min(Math.log1p(forks) * 1.0, 6)
    } else if (source === 'hashnode') {
      // followersCount is real Hashnode followers. Bonus for post count
      // (active writers = active community members).
      const posts = (metadata.postCount as number | undefined) ?? 0
      if (posts > 0) score += Math.min(Math.log1p(posts) * 1.5, 10)
    } else if (source === 'sourcehut') {
      // SourceHut has no followers/follows in their schema. Bonus for
      // description length (longer bio = more invested in the platform).
      const bio = builder.bio ?? ''
      if (bio.length > 50) score += 2
      if (bio.length > 200) score += 3
    } else if (source === 'devpost') {
      // Devpost exposes no followers; followersCount is intentionally left
      // undefined (see src/lib/sources/devpost.ts). Project count is the
      // only quantitative signal scraping can reliably get.
      const projectsCount = (metadata.projectsCount as number | undefined) ?? 0
      if (projectsCount > 0) score += Math.min(Math.log1p(projectsCount) * 4, 15)
    } else if (source === 'producthunt') {
      // Total votes across launches is already in followersCount; this
      // rewards a single breakout launch specifically. Recency comes from
      // metadata.lastSeen via the default branch above.
      const best = (metadata.bestVotes as number | undefined) ?? 0
      if (best > 0) score += Math.min(Math.log1p(best) * 1.2, 10)
    } else if (source === 'bluesky') {
      // Followers/quality/topics ride the default paths; no lastSeen in v1
      // so recency uses the neutral default. Custom domain handle = a
      // deliberate identity/verification act, worth a small flat bonus.
      if (metadata.customDomainHandle === true) score += 5
    }

    // ---------- Quality signals (0-10 pts) ----------
    if (builder.bio) score += 4
    if (builder.avatarUrl) score += 2
    if (builder.profileUrl) score += 1
    if (builder.displayName) score += 3

    // Clamp 0-100
    const final = Math.max(0, Math.min(100, Math.round(score)))
    return { ...builder, score: final }
  })
}

/**
 * Reciprocal-rank-fusion constant. 60 is the value from the original RRF paper and the one
 * pgvector/hybrid-search implementations conventionally use; it damps the difference between the
 * top few ranks so a source's #1 does not completely dominate another source's #2.
 */
const RRF_K = 60

export interface FusedBuilder extends ScoredBuilder {
  /**
   * Cross-source comparable relevance, used for ordering. `score` stays exactly as it was — an
   * absolute per-source 0-100 figure the UI can display — because the two answer different
   * questions and conflating them is what made ranking wrong in the first place.
   */
  fusedScore: number
}

/**
 * Normalizes before fusing (plan 43 Phase 2: "normalize scores before fusion").
 *
 * `scoreBuilders` produces an absolute 0-100 score from a per-source `if (source === ...)` ladder
 * fed by raw magnitudes that are not comparable across platforms: GitHub stargazers, Reddit active
 * users, HN submission counts, HuggingFace downloads. Sorting those numbers against each other
 * directly — which is what a single global `sort((a, b) => b.score - a.score)` did — ranks sources
 * against each other by whichever platform happens to publish the largest integers, not by
 * relevance. GitHub wins that comparison structurally, so a highly relevant DEV.to author lost to a
 * mediocre GitHub repo essentially every time.
 *
 * Rank fusion sidesteps the incommensurability instead of trying to calibrate it: within each
 * source the absolute scores ARE comparable, so each source is ranked independently and only the
 * resulting positions — 1st, 2nd, 3rd — are combined. A position means the same thing everywhere.
 *
 * Ordering is total and deterministic: fused score, then absolute score, then `source:sourceId`.
 * Without that last key, two builders with equal scores could swap places between identical
 * requests, which makes pagination drop and repeat rows.
 */
export function fuseByRank(builders: ScoredBuilder[]): FusedBuilder[] {
  const bySource = new Map<string, ScoredBuilder[]>()
  for (const builder of builders) {
    const bucket = bySource.get(builder.source)
    if (bucket) bucket.push(builder)
    else bySource.set(builder.source, [builder])
  }

  const fusedScores = new Map<string, number>()
  for (const bucket of bySource.values()) {
    // Rank within the source. Ties share the earlier rank's contribution, which keeps the fused
    // value a function of the scores alone rather than of connector arrival order.
    const ranked = [...bucket].sort((a, b) => b.score - a.score || identity(a).localeCompare(identity(b)))
    ranked.forEach((builder, index) => {
      fusedScores.set(identity(builder), 1 / (RRF_K + index + 1))
    })
  }

  return [...builders]
    .map((builder) => ({ ...builder, fusedScore: fusedScores.get(identity(builder)) ?? 0 }))
    .sort((a, b) =>
      b.fusedScore - a.fusedScore
      || b.score - a.score
      || identity(a).localeCompare(identity(b)),
    )
}

function identity(builder: RawBuilder): string {
  return `${builder.source}:${builder.sourceId}`
}

/**
 * Orders by absolute score. Retained for callers that only ever see one source (where absolute and
 * fused ordering agree by construction) — `fuseByRank` is what the multi-source search path uses.
 *
 * No longer sorts in place: `Array.prototype.sort` mutates, so this used to reorder the caller's
 * array as a side effect, including the arrays held in the search result cache.
 */
export function sortByScore(builders: ScoredBuilder[]): ScoredBuilder[] {
  return [...builders].sort((a, b) => b.score - a.score || identity(a).localeCompare(identity(b)))
}
