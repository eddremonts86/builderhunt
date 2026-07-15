import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/github'

/**
 * Lobsters source — community-curated tech news (programming, security,
 * distributed systems, languages, unix).
 *
 * API strategy: Lobsters has no user-search JSON endpoint, so we sample
 * `/hottest.json` + `/newest.json` (top + most recent stories), aggregate
 * by `submitter_user`, filter by query against story titles + tags, and
 * return one card per active user with their tags as topics and recency
 * from the most recent story they submitted.
 *
 * v1 limitations (documented in spec):
 *   - No bio (would require HTML scraping of /u/:username)
 *   - No avatar (same)
 *   - No karma (HTML only)
 *   - "followersCount" maps to max story score as a quality proxy
 */
interface LobstersStory {
  short_id: string
  created_at: string
  title: string
  url: string
  score: number
  flags: number
  comment_count: number
  description?: string
  description_plain?: string
  submitter_user: string
  user_is_author?: boolean
  tags: string[]
  short_id_url: string
  comments_url: string
}

interface UserAggregate {
  username: string
  stories: LobstersStory[]
  tags: Set<string>
  totalScore: number
  maxScore: number
  lastSeen: number // unix ms of newest story
  matchedStories: LobstersStory[] // stories that match the query
}

export interface SearchLobstersOptions {
  page?: number
  perPage?: number
}

const LOBSTERS_BASE = 'https://lobste.rs'

function storyMatchesQuery(story: LobstersStory, terms: string[]): boolean {
  if (terms.length === 0) return true
  const haystack = [
    story.title.toLowerCase(),
    story.description_plain?.toLowerCase() ?? '',
    story.tags.join(' ').toLowerCase(),
  ].join(' ')
  return terms.some((t) => haystack.includes(t))
}

async function fetchStories(endpoint: 'hottest' | 'newest'): Promise<LobstersStory[]> {
  try {
    const res = await fetch(`${LOBSTERS_BASE}/${endpoint}.json`, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (lobsters source)' },
    })
    if (!res.ok) return []
    return (await res.json()) as LobstersStory[]
  } catch {
    return []
  }
}

function aggregate(stories: LobstersStory[]): Map<string, UserAggregate> {
  const users = new Map<string, UserAggregate>()
  for (const story of stories) {
    const username = story.submitter_user
    if (!username) continue
    const ts = Date.parse(story.created_at)
    let user = users.get(username)
    if (!user) {
      user = {
        username,
        stories: [],
        tags: new Set(),
        totalScore: 0,
        maxScore: 0,
        lastSeen: 0,
        matchedStories: [],
      }
      users.set(username, user)
    }
    user.stories.push(story)
    user.totalScore += story.score
    if (story.score > user.maxScore) user.maxScore = story.score
    if (ts > user.lastSeen) user.lastSeen = ts
    for (const tag of story.tags) user.tags.add(tag)
  }
  return users
}

function userMatchesQuery(user: UserAggregate, terms: string[]): LobstersStory[] {
  if (terms.length === 0) return user.stories
  const matched: LobstersStory[] = []
  for (const story of user.stories) {
    if (storyMatchesQuery(story, terms)) matched.push(story)
  }
  return matched
}

export async function searchLobsters(
  keywords: string[],
  options: SearchLobstersOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const terms = keywords.map((k) => k.toLowerCase()).filter(Boolean)
  if (terms.length === 0) return []

  // Fetch hottest + newest in parallel; dedupe by short_id.
  const [hottest, newest] = await Promise.all([fetchStories('hottest'), fetchStories('newest')])
  const seen = new Set<string>()
  const all: LobstersStory[] = []
  for (const s of [...hottest, ...newest]) {
    if (seen.has(s.short_id)) continue
    seen.add(s.short_id)
    all.push(s)
  }
  if (all.length === 0) return []

  // Aggregate by user, then filter to those whose stories match the query.
  const users = aggregate(all)
  const matched: Array<{ user: UserAggregate; matched: LobstersStory[] }> = []
  for (const user of users.values()) {
    const m = userMatchesQuery(user, terms)
    if (m.length > 0) {
      user.matchedStories = m
      matched.push({ user, matched: m })
    }
  }

  // Sort by max score desc (quality proxy), then lastSeen desc.
  matched.sort((a, b) => {
    if (b.user.maxScore !== a.user.maxScore) return b.user.maxScore - a.user.maxScore
    return b.user.lastSeen - a.user.lastSeen
  })

  // Pagination: slice by page/perPage.
  const start = (page - 1) * perPage
  const slice = matched.slice(start, start + perPage)

  return slice.map(({ user, matched: matchedStories }) => {
    // Tags from matched stories (more focused on query), falling back to all tags.
    const matchedTags = new Set<string>()
    for (const s of matchedStories) for (const t of s.tags) matchedTags.add(t)
    const topics = Array.from(matchedTags.size > 0 ? matchedTags : user.tags).slice(0, 12)

    // Sample of recent matching story titles for the metadata (so future
    // / "matches X" UI can show context without re-fetching).
    const sampleTitles = matchedStories
      .slice(0, 3)
      .map((s) => s.title)
      .filter(Boolean)

    return {
      id: `lobsters-${user.username}`,
      kind: 'person' as const,
      source: 'lobsters' as const,
      sourceId: user.username,
      username: user.username,
      displayName: undefined,
      avatarUrl: undefined,
      bio: undefined,
      profileUrl: `${LOBSTERS_BASE}/u/${user.username}`,
      // No real followers; use max story score as a "quality proxy".
      followersCount: user.maxScore,
      language: undefined,
      country: undefined,
      topics,
      metadata: {
        storyCount: user.stories.length,
        matchedStoryCount: matchedStories.length,
        totalScore: user.totalScore,
        maxScore: user.maxScore,
        lastSeen: user.lastSeen,
        sampleTitles,
        // First matched story URL for quick link-out
        representativeUrl: matchedStories[0]?.short_id_url,
      },
    }
  })
}
