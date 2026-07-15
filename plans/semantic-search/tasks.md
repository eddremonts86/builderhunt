# Tasks: AI-Powered Semantic Search

## Phase 1: Database Setup & Migration
- [ ] Install `pgvector` in the PostgreSQL database image (Docker Compose)
- [ ] Create Drizzle migration:
  - [ ] Add `vector` extension trigger
  - [ ] Add `embedding` column to `builders` table
  - [ ] Create HNSW index on `embedding`
- [ ] Update `src/shared/lib/db/schema.ts` with custom Drizzle vector type

## Phase 2: Embedding Generation Service
- [ ] Create `src/lib/ai/embedding.ts`
  - [ ] Implement Gemini API `text-embedding-004` integration
  - [ ] Implement local Ollama API fallback for local development
  - [ ] Write text composer utility to generate developer profile strings
- [ ] Implement background worker or queue to compute embeddings asynchronously upon profile creation/update

## Phase 3: Query Execution & Pipeline
- [ ] Implement vector search runner in `src/lib/search.ts`
- [ ] Write Drizzle raw SQL query calculating cosine similarity
- [ ] Integrate similarity threshold (>0.65) and ranking logic
- [ ] Implement query keyword extraction fallback for external APIs search when local matches are low

## Phase 4: UI Dashboard Integration
- [ ] Add "Semantic Search" toggle switch to search interface
- [ ] Bind toggle state to search parameters and URL state
- [ ] Render Similarity Score badges (`% match`) on developer result cards
- [ ] Implement specialized indigo/purple styling for semantic results

## Phase 5: Verification & Testing
- [ ] Create seed scripts with sample profiles in `scripts/db/seed-semantic.ts`
- [ ] Write Vitest integration tests to verify search relevance on query matches
