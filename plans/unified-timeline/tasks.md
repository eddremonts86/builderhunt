# Tasks: Unified "Build in Public" Timeline

## Phase 1: Event Normalizer Utilities
- [ ] Create `src/lib/timeline/normalizer.ts`
  - [ ] Write interface contracts for event structures
  - [ ] Implement GitHub push events converter
  - [ ] Implement GitLab activities converter
  - [ ] Implement Blog post (Dev.to/Hashnode) converter
  - [ ] Implement Bluesky social post converter
- [ ] Write unit tests for normalizers under `tests/timeline/normalizer.test.ts`

## Phase 2: Server Aggregator & Cache Layer
- [ ] Add `timeline` and `timelineCachedAt` properties inside `builders.metadata` schema description
- [ ] Create `src/lib/timeline/cache.ts`
  - [ ] Implement parallel fetch loop with `Promise.allSettled`
  - [ ] Set strict fetch timeout helper (800ms)
  - [ ] Implement database cache sync script (reading/writing to `builders`)
  - [ ] Return sorted sliced array of top 15 events

## Phase 3: Timeline UI Layout
- [ ] Create `src/modules/builder-profile/components/BuilderTimeline.tsx`
  - [ ] Build vertical timeline axis layout
  - [ ] Design custom icons and borders matching event sources (GitHub, Bluesky, Devto)
  - [ ] Add timeline filtering states (All, Code, Writing, Social)
  - [ ] Implement transition animations for filters using simple CSS transitions or motion utilities

## Phase 4: Verification & Edge Cases
- [ ] Assert API failure resilience by mocking one network failure
- [ ] Verify profile load speeds remain under 200ms when cache hits occur
