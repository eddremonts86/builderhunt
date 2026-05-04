import { RawBuilder } from '~/lib/sources/github'

interface DeduplicationKey {
  username: string
  source: string
}

export function deduplicateBuilders(builders: RawBuilder[]): RawBuilder[] {
  const seen = new Map<string, RawBuilder>()

  for (const builder of builders) {
    const key = builder.username.toLowerCase()
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, builder)
    } else {
      // Merge: keep the one with more metadata or higher followers
      const merged = {
        ...existing,
        followersCount: Math.max(existing.followersCount ?? 0, builder.followersCount ?? 0),
        topics: [...new Set([...existing.topics, ...builder.topics])],
        metadata: { ...existing.metadata, ...builder.metadata },
        // Prefer the one with avatar
        avatarUrl: existing.avatarUrl ?? builder.avatarUrl,
        bio: existing.bio ?? builder.bio,
      }
      seen.set(key, merged)
    }
  }

  return Array.from(seen.values())
}