import type { RawBuilder } from '~/lib/sources/github'

interface ScoredBuilder extends RawBuilder {
  score: number
}

export function scoreBuilders(builders: RawBuilder[]): ScoredBuilder[] {
  const now = Date.now()

  return builders.map(builder => {
    const metadata = builder.metadata ?? {}
    let score = 0

    // Base: followers
    score += (builder.followersCount ?? 0) * 1.5

    // Recency bonus (mocked from lastSeen in metadata)
    const lastSeen = (metadata.lastSeen as number | undefined) ?? now
    const daysSinceLastSeen = (now - lastSeen) / (1000 * 60 * 60 * 24)
    if (daysSinceLastSeen < 1) score += 50
    else if (daysSinceLastSeen < 7) score += 30
    else if (daysSinceLastSeen < 30) score += 10

    // Topics relevance
    score += (builder.topics?.length ?? 0) * 5

    // GitHub stars bonus
    const stars = (metadata.stars as number | undefined) ?? 0
    score += Math.log1p(stars) * 10

    // Quality metadata
    if (builder.bio) score += 5
    if (builder.avatarUrl) score += 3
    if (builder.profileUrl) score += 1

    // Reddit active users bonus
    const activeUsers = (metadata.activeUsers as number | undefined) ?? 0
    score += Math.log1p(activeUsers) * 2

    // HN karma bonus
    score += Math.log1p(builder.followersCount ?? 0) * 3

    return { ...builder, score: Math.round(score) }
  })
}

export function sortByScore(builders: ScoredBuilder[]): ScoredBuilder[] {
  return builders.sort((a, b) => b.score - a.score)
}