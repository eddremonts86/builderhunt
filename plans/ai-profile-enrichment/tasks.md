# Tasks: AI Profile Enrichment

## Phase 1: LLM Service Integration
- [ ] Create `src/lib/ai/enrich.ts`
  - [ ] Initialize Gemini API client reading `GEMINI_API_KEY`
  - [ ] Write system prompt instructing structured JSON output for profiles
  - [ ] Implement text truncation utility to prevent prompt token limit overflow
- [ ] Write mock responses and unit tests in `tests/ai/enrich.test.ts`

## Phase 2: Server Action & DB Sync
- [ ] Create TanStack Start Server Function `enrichBuilderProfile`
  - [ ] Verify viewer session credentials
  - [ ] Implement cache checking (check if `metadata.aiEnrichedAt` is < 30 days old)
  - [ ] Aggregate builder data from DB (repos, posts, bio)
  - [ ] Invoke LLM service and save result to `builders.metadata.aiEnrichment` JSONB property
  - [ ] Set `metadata.aiEnrichedAt = Date.now()`

## Phase 3: Profile Detail UI
- [ ] Implement the "Developer Persona Bento Card" component in `src/modules/builder-profile/components/DeveloperPersonaCard.tsx`
- [ ] Update builder details routing view to call `enrichBuilderProfile` server action
- [ ] Implement skeletal load spinner with modern micro-animations
- [ ] Style seniority tags and strengths pill badges with sleek typography and gradients
- [ ] Add the "Refresh AI Summary" button for verified profile owners

## Phase 4: Limits & Quotas
- [ ] Implement per-user rate limit counter for AI calls (e.g. database tracking of requests count per IP/user per day)
- [ ] Handle empty profile edge cases gracefully (skip API calls and show a static placeholder card)
