# Plan: Co-founder & Team Synergy Matchmaking

## Goal recap

Implement a matching algorithm and comparison dashboard that evaluates technical complementarily, coding habits, and project synergy between two developers, displaying results in an interactive, visual radar chart dashboard.

## Why this is a valuable addition

1. **Focuses on Team Building**: Modern product building is collaborative. Sourcing individual developers is only half the battle; building cohesive teams is the goal.
2. **First-of-its-Kind Feature**: Sourcing platforms generally lack pairwise comparison engines. An interactive compatibility radar chart places BuilderHunt firmly in next-generation recruiting territory.
3. **High Engagement Loops**: Encourages developers to link their own profiles and run self-matches against potential co-founders or teammates, driving viral onboarding.

## Phases

### Phase 1: Matchmaking Utility (`src/lib/matchmaking/synergy.ts`)
- Implement the static scoring rules (language overlaps, complementary topics, focus variance).
- Implement the LLM-powered detailed comparison prompt using Gemini.
- Write unit tests validating that the synergy score falls strictly in the range of 0-100.

### Phase 2: Server Function
- Create a TanStack Start Server Function `checkTeamSynergy({ builderId1, builderId2 })`.
- Fetch profiles and AI Enrichment records.
- Run the matchmaking logic, store comparisons in cache, and return the structured response.

### Phase 3: Matchmaking Dashboard UI
- Create the `/match` route folder under `src/routes/_dashboard/match/`.
- Build the dual selector interface: users select candidates from their saved collections or search results.
- Implement an interactive double-radar chart using pure SVG paths (ensuring responsive, framework-agnostic rendering without heavy chart libraries).
- Render bento cards detailing highlights and friction points with micro-animations.

### Phase 4: Verification & Limits
- Mock Gemini API comparison calls in test suites.
- Verify page performance: caching comparisons ensures subsequent loads of identical pairings take under 10ms.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Friction comments perceived as too negative** | Medium | Low | Instruct the LLM prompt to frame friction constructively (e.g. "Pragmatic vs. Structured" rather than "Messy vs. Slow"). |
| **API Costs for pairwise checks** | High | Medium | Cache matching results in memory or database using a compound key: `match:${builderId1}:${builderId2}` (sorted alphabetically to prevent duplicate entries). Cache TTL: 7 days. |

## Rollback plan

- Keep the matching portal modular. Hide `/match` routes if disabled via `ENABLE_MATCHMAKING=false` configuration parameters.
