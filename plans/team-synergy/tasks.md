# Tasks: Co-founder & Team Synergy Matchmaking

## Phase 1: Matchmaking Utility
- [ ] Create `src/lib/matchmaking/synergy.ts`
  - [ ] Implement baseline scoring matrix (language matching, focus variance)
  - [ ] Write comparison prompt for Gemini API
  - [ ] Format structured JSON response mapping
- [ ] Write unit tests verifying score calculation ranges under `tests/matchmaking/synergy.test.ts`

## Phase 2: Server Action & Caching
- [ ] Create TanStack Start Server Function `checkTeamSynergy`
  - [ ] Verify user session credentials
  - [ ] Implement query caching checking (using compound key `${builderId1}-${builderId2}`)
  - [ ] Fetch profiles data and call matchmaking utility
  - [ ] Cache resolved comparison for 7 days

## Phase 3: Sinergy Dashboard UI
- [ ] Create route files under `src/routes/_dashboard/match/`
  - [ ] Build the builder comparison selector panel
  - [ ] Create `DoubleRadarChart` SVG component displaying skill distributions
  - [ ] Render circular compatibility percentage card with svelte progress stroke
  - [ ] Build bento grid detailing complementary analysis and potential friction blocks

## Phase 4: Verification & Edge Cases
- [ ] Verify responsive behavior of the radar chart on small layouts
- [ ] Mock LLM timeouts to verify that matchmaking falls back to a purely algorithmic score instead of crashing the view
