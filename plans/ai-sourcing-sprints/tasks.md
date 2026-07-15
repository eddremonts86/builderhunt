# Tasks: AI Talent Sourcing Sprints

## Phase 1: Database Setup
- [ ] Create database migration for `sourcing_sprints` and `sprint_results`
- [ ] Update `src/shared/lib/db/schema.ts` with table structures
- [ ] Configure cascade delete relations for sprint results

## Phase 2: Sourcing Worker Implementation
- [ ] Create `src/lib/agents/sourcing-worker.ts`
  - [ ] Implement query translator prompt using LLM
  - [ ] Integrate database tasks runner with task queue or interval loop
  - [ ] Write sequential sourcing calls with rate-limit delays (sleep helper)
- [ ] Set up worker recovery process on server restart

## Phase 3: Code Vetting Pipeline
- [ ] Create `src/lib/agents/vetting.ts`
  - [ ] Implement source code file fetcher from GitHub/GitLab
  - [ ] Write prompt for code screening using Gemini API
  - [ ] Save calculated scores and review summaries into `sprint_results`

## Phase 4: Sprints UI & Dashboards
- [ ] Create routes under `src/routes/_dashboard/sprints/`
  - [ ] Implement Sprint Dashboard (`index.tsx`) showing active and past sprints
  - [ ] Build Sprints Creator Form (`new.tsx`)
  - [ ] Build Sprints Progress Tracker with live state logs
  - [ ] Build Sprints Report View (`$sprintId.tsx`) displaying matching profiles with AI reviews

## Phase 5: Verification & Tests
- [ ] Write unit tests for sourcing worker scheduler
- [ ] Validate rate limit safety by running a test sprint locally for 10 minutes
