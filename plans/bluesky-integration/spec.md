# Feature: Bluesky Integration

## Problem

BuilderHunt aggregates profiles across major developer networks (GitHub, GitLab, Dev.to, HN, StackOverflow, etc.). However, many tech founders and software builders are increasingly moving their public discourse and "building in public" updates to **Bluesky** (via the open AT Protocol). 

Without Bluesky, BuilderHunt misses:
1. Real-time updates of active projects shared by developers on their decentralized social feeds.
2. An active demographic of builders who choose decentralized, open-source social ecosystems.
3. Authentic developer identity connections (many developers verify their Bluesky handles via their own domain names or GitHub profile links).

## Goal

Search and ingest builder profiles and posts from Bluesky (`bsky.app`) to:
- Retrieve actor/user profiles based on keywords (matching handle, display name, or bio content).
- Show their follower counts and public posts/updates as signal quality.
- Link their profiles uniaxially with other sources (GitHub, website) where domains or usernames match.

## Non-goals

- **No private message indexing.** Only public actors and public posts (feeds).
- **No full AT Protocol server hosting.** We only query the public AppView/Relay endpoints.
- **No rich-text rendering engine for all post cards.** We only display text summaries and links of relevant updates.

## User stories

1. **As a user**, when I search for "solana rust builder", I want to see Bluesky profiles who have this phrase in their bios or handles alongside Github profiles.
2. **As a user**, I want a "Bluesky" source filter pill on the search dashboard to toggle results from Bluesky.
3. **As a user**, I want to see a developer's recent Bluesky posts directly on their builder detail card to check what they are currently shipping or discussing.

## API summary

- **Base Endpoint (AppView / Public API)**: `https://public.api.bsky.app/xrpc/`
- **Auth**: None required for read-only queries on public AppView directories. No API key setup needed for basic queries.
- **Key Methods**:
  - `GET /xrpc/app.bsky.actor.searchActors?q={query}&limit={limit}`: Fuzzy search actors by term in handle, display name, or description.
  - `GET /xrpc/app.bsky.actor.getProfile?actor={handle_or_did}`: Retrieve detailed profile (followers count, follows count, avatar, description).
  - `GET /xrpc/app.bsky.feed.getAuthorFeed?actor={handle_or_did}&limit={limit}`: Retrieve recent posts from the builder.
- **Rate Limit**: AppView endpoints are rate-limited per IP. For high-volume server rendering, we can cache responses or use standard fetch headers.

## Data shape

Reuses the `RawBuilder` structure with `source: 'bluesky'`:

```ts
export interface RawBuilder {
  id: string              // `bsky-${did}`
  kind: 'person'
  source: 'bluesky'
  sourceId: string        // DID (Decentralized Identifier, e.g. `did:plc:1234...`)
  username: string        // handle (e.g. `xyz.bsky.social` or custom domain)
  displayName?: string    // display name
  avatarUrl?: string      // avatar CDN link
  bio?: string            // profile description
  profileUrl: string      // `https://bsky.app/profile/${handle}`
  followersCount?: number // followersCount from profile query
  language?: string
  country?: string
  topics: string[]        // parsed from hashtags or bio keywords
  metadata: {
    did: string
    followsCount: number
    postsCount: number
    recentPosts: Array<{
      uri: string
      text: string
      createdAt: string
      likeCount: number
      repostCount: number
    }>
  }
}
```

## UX integration

- Add `bluesky` to the `Source` union type.
- Add Bluesky SVG Icon (custom butterfly logo) to the codebase.
- Color theme: Celeste Blue (`#0085ff` / `rgb(0, 133, 255)`).
- Pill badge style: `.badge-bluesky`.

## Success metrics

- **Primary**: Users click through to Bluesky profiles at a rate comparable to Twitter/LinkedIn link-outs.
- **Secondary**: Increased coverage of non-GitHub "build-in-public" projects that are otherwise hard to index automatically.

## Open questions

- **How do we extract location and language?** Bluesky profiles do not have formal location or language fields in their core schemas. 
  - *Recommendation*: Use simple NLP or regex heuristics on the bio text, or fallback to parsing the languages declared in their posts feed (metadata has post language tags).
- **Caching profile queries**: Since we do `searchActors` followed by `getProfile` to fetch follower counts, we should bundle this or cache it aggressively.
