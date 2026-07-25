---
title: How I built a 12-source developer search engine with TanStack Start
description: An architecture walk-through of BuilderHunt's federated search — one module per source, a merge/dedup pass, and a scoring function that doesn't just count stars.
slug: building-12-source-search-tanstack-start
date: 2026-07-27
tags: [engineering, tanstack-start, architecture]
author: edd
---

# How I built a 12-source developer search engine with TanStack Start

This is the technical companion to ["Why I built BuilderHunt"](/blog/why-i-built-builderhunt) —
how the search actually works, for anyone building something similar. BuilderHunt fans a single
query out across GitHub, Hacker News, dev.to, Reddit, Stack Overflow, npm, Hugging Face, GitLab,
Codeberg, Hashnode, SourceHut, Devpost, Product Hunt and Bluesky, merges the results, dedupes
people who show up more than once, and ranks what's left. Here's the shape of it.

## One module per source, one shared contract

Every source lives in its own file under `src/lib/sources/` (`github.ts`, `hn.ts`, `npm.ts`,
and so on) and returns the same normalized shape regardless of how wildly different the
upstream APIs are:

```typescript
// src/lib/sources/types.ts
export type BuilderKind = 'person' | 'repo'

export interface RawBuilder {
  id: string
  kind: BuilderKind
  source: SourceName
  sourceId: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  country?: string
  topics: string[]
  metadata: Record<string, unknown>
}
```

The `metadata` bag is the pressure valve here. GitHub gives you stargazers and topics.
Stack Overflow gives you reputation and answer tags. Hacker News gives you karma and submission
count. Rather than forcing every source into an identical set of typed fields — which either
means dozens of `| undefined` columns or a lossy lowest-common-denominator shape — each source
writes what it actually has into `metadata`, and only the scoring function (next section) needs
to know the source-specific keys. Adding a fourteenth source means writing one file that returns
`RawBuilder[]`; nothing else in the pipeline needs to change.

## Dedup: merge, don't drop

The same person can plausibly show up from two sources — most commonly, a GitHub user whose
username also happens to match a Stack Overflow or dev.to handle. `deduplicateBuilders`
(`src/lib/dedup.ts`) keys on lowercased username and merges rather than picks one:

```typescript
export function deduplicateBuilders(builders: RawBuilder[]): RawBuilder[] {
  const seen = new Map<string, RawBuilder>()

  for (const builder of builders) {
    const key = builder.username.toLowerCase()
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, builder)
    } else {
      const merged = {
        ...existing,
        followersCount: Math.max(existing.followersCount ?? 0, builder.followersCount ?? 0),
        topics: [...new Set([...existing.topics, ...builder.topics])],
        metadata: { ...existing.metadata, ...builder.metadata },
        avatarUrl: existing.avatarUrl ?? builder.avatarUrl,
        bio: existing.bio ?? builder.bio,
      }
      seen.set(key, merged)
    }
  }

  return Array.from(seen.values())
}
```

Taking the max of `followersCount` and unioning `topics` means a match on two sources ends up
*more* informative than either source alone, instead of arbitrarily discarding one of them.

## Scoring: source-specific signals feeding one number

`scoreBuilders` (`src/lib/score.ts`) is a single function with a fixed points budget — popularity
(0-30, log-scaled so a 100k-follower account doesn't drown out a 1k one), recency (0-30, decayed
by days since last activity), topic-match breadth (0-15), and a source-specific bonus (0-15) that
switches on `builder.source` to read the right `metadata` key:

```typescript
} else if (source === 'stackoverflow') {
  const matched = (metadata.matchedTags as string[] | undefined) ?? []
  if (matched.length >= 2) score += 5
  if (matched.length >= 3) score += 5
  const postCount = (metadata.postCount as number | undefined) ?? 0
  score += Math.min(Math.log1p(postCount) * 1.5, 10)
} else if (source === 'npm') {
  const packageCount = (metadata.packageCount as number | undefined) ?? 0
  if (packageCount > 0) {
    score += Math.min(Math.log1p(packageCount) * 2, 8)
  }
}
```

The deliberate choice here is a `switch`-shaped bonus, not a generic weighted-average formula —
"reputation" on Stack Overflow and "stars" on GitHub aren't the same kind of signal, and trying
to force them onto one universal scale would have meant picking arbitrary conversion factors
that don't mean anything. `sortByScore` then does exactly what it says:

```typescript
export function sortByScore(builders: ScoredBuilder[]): ScoredBuilder[] {
  return builders.sort((a, b) => b.score - a.score)
}
```

## Two-tier caching: memory first, Redis behind it

`searchBuilders` (`src/lib/search.ts`) checks an in-process `Map` first (5-minute TTL, zero
network cost, but gone on every server restart or across instances), then falls back to Redis
if it's configured, and only then actually calls out to all the source APIs:

```typescript
// Check Redis cache (if available)
try {
  const { getRedis } = await import('~/shared/lib/redis')
  const redis = await getRedis()
  if (redis) {
    const redisKey = `search:${cacheKeyStr}`
    const cachedRaw = await redis.get(redisKey)
    // ... parse and return if present
  }
} catch {
  // Redis unavailable — fall through to live search
}
```

Both cache layers fail open: if Redis isn't configured (or errors), the code falls through to a
live fetch rather than throwing. For a search product, a slow-but-correct response beats a hard
500 by a wide margin — the try/catch around the Redis call exists specifically so a missing
`REDIS_URL` in local dev never breaks search, only skips the extra cache tier.

## Where TanStack Start actually helps

All of the above runs entirely server-side, invoked from a TanStack Start SSR route — the
`/explore` page renders its first page of results with no client-side loading spinner, because
the search executes during the server render, not after hydration. That matters for a search
product specifically: the first meaningful thing a visitor sees is real results, not a skeleton
waiting on a client-side fetch.

## Try it live

The [12-sources listicle](/blog/12-sources-developer-search) covers what each source is *good*
for; this post is what happens after you hit search. See it running against real, current data
at [`/explore?q=rust+cli`](/explore?q=rust+cli) — that's a live query through this exact
pipeline, not a static screenshot.

[Try BuilderHunt free](/auth/sign-up) if you want to run your own query against all twelve-plus
sources.
