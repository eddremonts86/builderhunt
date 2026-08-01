import type { RawBuilder } from '~/lib/sources/types'

/**
 * Collapses duplicate builder records — but only ones that are genuinely the same account.
 *
 * The key is `source:sourceId` (plan 43 Phase 2, "replace global username deduplication with
 * source-aware candidate keys"). Until 2026-08-01 it was the bare lowercased username, which meant
 * `github:alice` and `hn:alice` were merged into a single record on the assumption that one
 * username is one person. Across independent platforms that assumption is simply false, and it
 * failed in three ways at once:
 *
 *   - Two unrelated people with the same handle were shown to the user as one builder, carrying
 *     one's follower count, the union of both's topics, and a merged metadata blob.
 *   - The survivor kept the *first-seen* `source`, and `scoreBuilders` selects its scoring branch
 *     from `source` — so a merged record was scored under whichever connector answered first.
 *     GitHub is always pushed first, so an HN account could be scored against GitHub's stargazer
 *     curve.
 *   - The record that lost the merge vanished from results, so a real, distinct builder became
 *     unfindable because someone on another platform had taken the same handle.
 *
 * Deciding that two source accounts belong to the same human is a real problem with real evidence
 * requirements, and it is Phase 3's job (canonical human identity, with reversible merges and a
 * review queue for probabilistic matches). It is not something a string comparison may do silently,
 * so this function no longer tries.
 *
 * The merge below therefore only fires for the same account arriving twice — a connector returning
 * it on two pages, or two keyword queries overlapping — where combining is correct.
 */
export function deduplicateBuilders(builders: RawBuilder[]): RawBuilder[] {
  const seen = new Map<string, RawBuilder>()

  for (const builder of builders) {
    const key = `${builder.source}:${builder.sourceId}`
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, builder)
    } else {
      // Same account seen twice: take the richer of each field.
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
