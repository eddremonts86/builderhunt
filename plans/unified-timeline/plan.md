# Plan: Unified "Build in Public" Timeline

## Goal recap

Build a standardized chronological activity pipeline that aggregates, caches, and elegantly renders a builder's public contributions (commits, posts, socials, Q&As) on their profile sheet.

## Why this is a valuable addition

1. **Shows Shipping Velocity**: A static profile tells you what a developer knows. A timeline shows you what they did *this week*, serving as a real indicator of coding passion and velocity.
2. **Aggregates Multi-Source Context**: A recruiter doesn't have to parse raw JSON feeds or open 4 browser tabs. They see a single unifed story of the candidate's active building process.
3. **Visually Premium**: A functional, live-refreshing timeline makes the app feel responsive and alive, matching high-end design tastes.

## Phases

### Phase 1: Event Normalizer Utility (`src/lib/timeline/normalizer.ts`)
- Design functions to map API payloads into the unified `TimelineEvent` contract.
  - Map GitHub `PushEvent` -> Extract repository, commit messages, and branches.
  - Map GitLab `Event` -> Extract target projects and action name.
  - Map Dev.to/Hashnode API items -> Map title, URL, tags, and summary.
  - Map Bluesky `feed` post -> Extract text, links, and likes.
- Implement sorting: `events.sort((a, b) => b.timestamp - a.timestamp)`.

### Phase 2: Server Cache Layer (`src/lib/timeline/cache.ts`)
- Modify `builders` database schema metadata to support `timeline` array cache and `timelineCachedAt` timestamp.
- Write a resolver action `getBuilderTimeline(builderId)`:
  - Check if cache is fresh (< 1 hour).
  - If stale, trigger parallel fetches (GitHub, Dev.to, Bluesky).
  - Merge, slice to top 15 events, update database cache, and return.

### Phase 3: UI Timeline Component
- Create `src/modules/builder-profile/components/BuilderTimeline.tsx`.
- Design cards using HSL-based palettes matching the original source colors:
  - GitHub: Dark gray border and git branch icons.
  - Bluesky: Light blue accents.
  - Blog: Purple/indigo notes.
- Integrate filter state (e.g., matching event types) using a simple button strip.

### Phase 4: Verification & Performance
- Set up unit tests verifying the normalizer maps various feed payloads accurately without throwing undefined errors.
- Verify rate limit safety: if one API fails (e.g. StackOverflow returns 429), resolve the remaining feeds gracefully instead of failing the request.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Slow API queries blocking page load** | High | High | Run fetches in parallel using `Promise.allSettled`. Enforce a strict 800ms timeout per external call. If a call times out, ignore it and render the rest. |
| **Out-of-sync events timeline** | Medium | Low | Trust the source timestamps. Filter out events dated future or past 1 year to prevent timestamp formatting anomalies. |

## Rollback plan

- Keep the timeline block optional in the UI view. If `getBuilderTimeline` fails or is disabled via environment configuration (`ENABLE_TIMELINE=false`), render a static "Recent Projects" folder view.
