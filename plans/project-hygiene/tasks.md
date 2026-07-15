# Tasks: Maintenance & Project Hygiene Checker

## Phase 1: Database Setup
- [ ] Update `builders` database schema metadata type description to include `projectHygiene` fields
- [ ] Export schemas inside `src/shared/lib/db/schema.ts`

## Phase 2: Sourcing Scanner Pipeline
- [ ] Create `src/lib/hygiene/scanner.ts`
  - [ ] Implement fetch queries to retrieve repository issues lists
  - [ ] Implement fetch queries to retrieve pull request lists
  - [ ] Write directory contents checker to verify workflows folder and documentation file presence
  - [ ] Implement scoring algorithm computing issue rates and resolution velocity
- [ ] Write unit tests verifying parser metrics output under `tests/hygiene/scanner.test.ts`

## Phase 3: Server Action & Caching
- [ ] Create TanStack Start Server Function `calculateProjectHygiene`
  - [ ] Verify user session credentials
  - [ ] Implement cache checking (check if `lastAnalyzedAt` is < 15 days old)
  - [ ] Fetch repository lists and trigger scanner pipeline
  - [ ] Update builder database row with calculation outcomes

## Phase 4: UI Dashboard Panel
- [ ] Create `src/modules/builder-profile/components/ProjectHygienePanel.tsx`
  - [ ] Build circular progress gauges displaying global score
  - [ ] Render green/grey status icons indicating pipeline automation (CI/CD active)
  - [ ] Design table grid displaying health details (open issues, close rate, doc score) per repository
- [ ] Mount the hygiene panel inside the builder detail sheet tabs

## Phase 5: Verification & Safety
- [ ] Validate API recovery when Github quota limits are hit (ensure it fails silently without blocking profile views)
