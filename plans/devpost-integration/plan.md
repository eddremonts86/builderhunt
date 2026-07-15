# Plan: Devpost Integration

## Goal recap

Integrate Devpost as a source to discover active builders who build, submit, and win hackathons, mapping their project-based portfolios and linked social credentials.

## Why this is a valuable addition

1. **Practical Shipping Signal**: Developers who participate in hackathons are high-velocity creators. Winning a hackathon represents a strong signal of utility, collaboration, and high execution speed.
2. **Detailed Project Context**: Devpost submissions describe the actual business case, technical architecture, and struggles of a project, providing richer context than raw git commits.
3. **Implicit Verification**: Devpost profiles frequently link verified GitHub and LinkedIn accounts, which serves as a bridging identity to deduplicate profiles across platforms.

## Phases

### Phase 1: HTML Parser & Fetcher (`src/lib/sources/devpost.ts`)
- Implement a fetcher utilizing standard node fetch headers (simulating a clean browser requests to avoid blocking).
- Build parser logic using lightweight regex or HTML traversal.
- Implement two core flows:
  - **Query search**: Fetch `https://devpost.com/software/search?query={keywords}`. Extract project names, taglines, and associated developer handles.
  - **Profile lookup**: For each unique developer handle found, load `https://devpost.com/{username}` and parse:
    - Display name, bio, social links (GitHub, LinkedIn, Twitter).
    - Submissions list (project name, tech stack used, winner badges).
- Map the data structure to `RawBuilder` models.

### Phase 2: Pipeline Integration
- Add `'devpost'` to search options.
- Integrate the fetcher into `src/lib/search.ts`.
- Update the deduplication service in `src/lib/dedup.ts` to merge Devpost hits into GitHub hits if the Devpost profile links a matching GitHub handle.

### Phase 3: Scoring Rules (`src/lib/score.ts`)
- Add specific scoring rules for Devpost builders:
  - **Popularity**: Mapped to total projects submitted (0-15 pts) + hackathons won multiplier.
  - **Trophy Bonus**: Add points for winning awards:
    - Winner of a hackathon: +15 pts.
    - Multiple wins (>2): +25 pts.
  - **Recency**: Score based on the date of their latest submission (0-20 pts).
  - **Social Bridging**: Boost score (+5 pts) if they have linked 2+ social profiles (GitHub, LinkedIn, Twitter) as it shows professional credibility.

### Phase 4: UI & Styling
- Add the Devpost brand icon.
- Implement `.badge-devpost` using a dark teal/grey color theme.
- Render the hackathon projects portfolio list on the profile slide-out card.

### Phase 5: Verification & Safety
- Build tests with saved HTML fixtures of Devpost pages to assert that the parser is working and doesn't crash on incomplete profiles.
- Implement rate limiting (delaying sequential profile scrapes) to ensure the server IP does not get blocked.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Parser breaks due to HTML layout updates** | High | Medium | Write robust, generalized tag parsing. Wrap parsing logic in a try-catch block so it fails silently, returning an empty array without crashing the app. |
| **IP-based block/Captchas** | Medium | High | Cache queries for 1 hour. Stagger profile detail lookups or limit the number of profiles fetched to the top 10 results per search query. |

## Rollback plan

- Keep the integration behind the `ENABLE_DEVPOST=false` flag.
- If Devpost blocks the server IP, the app will catch the connection error and disable the source at runtime, logging the event for diagnostics.
