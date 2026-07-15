# Feature: Unified "Build in Public" Timeline

## Problem

A developer's public activity is fragmented. To understand their current interests and output quality, a user has to check:
- GitHub/GitLab to see recent commits.
- Dev.to/Hashnode to check their articles.
- Bluesky/Twitter to read their "building in public" thoughts.
- StackOverflow to check their expertise areas.

This fragmentation hides the "maker's momentum" (whether they are active right now and what exact problems they are tackling).

## Goal

Provide a chronological feed ("Unified Timeline") of a builder's public activities. This aggregates:
- Commits/Pushes (GitHub/GitLab).
- Blog posts (Dev.to/Hashnode).
- Social updates (Bluesky).
- Q&As (StackOverflow).

This timeline is rendered inside the builder details view, giving recruiters and developers a single place to see what the builder is shipping, writing, and talking about.

## Non-goals

- **No full git history storage.** We only cache the latest 15 events to keep the database footprint minimal.
- **No rich media players.** Social posts with videos/audios are rendered as text descriptions with links to the original platform.

## User stories

1. **As a user**, in the builder details view, I want to see a vertical chronological feed showing their git commits, social posts, and blog articles.
2. **As a user**, I want to filter the timeline by event types (e.g. toggle off social updates and only see commits/articles).
3. **As a builder**, I want to link and verify my social handles so that my unifies timeline aggregates accurately.

## Technical architecture

### 1. Unified Event Model
We create a standardized data contract for timeline events:

```ts
export type TimelineEventType = 'commit' | 'blog_post' | 'social_update' | 'forum_answer'

export interface TimelineEvent {
  id: string              // unique hash computed from sourceId + timestamp
  type: TimelineEventType
  source: 'github' | 'gitlab' | 'devto' | 'hashnode' | 'bluesky' | 'stackoverflow'
  title: string           // e.g. "Pushed 3 commits to repo/name" or "Published: How to use Rust async"
  description?: string    // commit messages summary, post tagline, or social post text
  url: string             // absolute link to the source activity
  timestamp: number       // Unix timestamp
  metadata: Record<string, unknown> // e.g. commit hash, votes, tags
}
```

### 2. Live Aggregator & Cache
- When a builder's profile is loaded:
  - Check the database for cached events. If cached events exist and are younger than 1 hour, return them.
  - If cache is stale or missing, spawn a task to fetch recent activities:
    - **GitHub**: `/users/:username/events/public` (extracts push events and issues).
    - **GitLab**: `/users/:id/events` (public project updates).
    - **Dev.to**: `/articles?username=:username` (latest articles).
    - **Bluesky**: `/xrpc/app.bsky.feed.getAuthorFeed` (latest post feed).
  - Normalize, sort by timestamp descending, and cache the top 15 events in `builders.metadata.timeline`.

## UX integration

- Create a vertical timeline layout in `src/modules/builder-profile/components/BuilderTimeline.tsx`.
- Use a dotted vertical line connecting activity cards.
- Customize the card designs:
  - **Commit cards**: Code block style snippet displaying commit messages.
  - **Blog cards**: Headline styling displaying article taglines.
  - **Social cards**: Text bubble styled with the signature Celeste Blue background.
- Include filter tabs at the top of the timeline: `All`, `Code`, `Writing`, `Social`.

## Success metrics

- **Deeper Profiling**: Recruiter click-through rates on external links drop by 30% because they can read the context directly on BuilderHunt.
- **Engagement**: Users scroll past the initial fold of the builder profile sheet in 50% of views to check the timeline.
