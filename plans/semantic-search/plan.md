# Plan: AI-Powered Semantic Search

## Goal recap

Enhance BuilderHunt's search dashboard by adding vector semantic search capabilities, using PostgreSQL's `pgvector` extension and text embedding APIs, allowing users to locate developers using natural language.

## Why this is a valuable addition

1. **Context-Aware Sourcing**: Recruiters and users often don't know the exact keyword tags developers use. Semantic search maps synonyms automatically (e.g. "AI integration" maps to "LLM", "OpenAI", "Prompt engineering", "RAG").
2. **Offline-First Capabilities**: By building a local database of developers, BuilderHunt can return instant results without being blocked by third-party API rate limits.
3. **Premium UX**: A search engine that understands natural language queries feels modern and matches the design taste of next-generation developer tooling.

## Phases

### Phase 1: Database Setup & pgvector Migration
- Add a new Drizzle migration to create the `vector` extension and add the `embedding` column.
- Write raw SQL triggers or scripts to initialize the HNSW index in PostgreSQL.
- Update `src/shared/lib/db/schema.ts` to include the `embedding` column definition using a custom type for Drizzle pgvector compatibility.

### Phase 2: Embedding Generation Service (`src/lib/ai/embedding.ts`)
- Implement a utility to connect to an embedding service.
  - Option A (Cloud): Gemini API `text-embedding-004` (Fast, highly accurate, requires API Key).
  - Option B (Local): Ollama running `nomic-embed-text` (Zero cost, fully local, requires Ollama running).
- Design the service to compose profile strings and return the 768-dimension array.
- Create an asynchronous processing queue (using a simple worker or event emitter) to avoid blocking HTTP requests when indexing new builders.

### Phase 3: Query Execution & Drizzle Helpers
- Write the database query logic inside `src/lib/search.ts`.
- Formulate the cosine similarity query. Use raw SQL template tags in Drizzle:
  ```ts
  import { sql } from 'drizzle-orm'
  // Cosine distance operator is <=> in pgvector. Distance = 1 - Cosine Similarity.
  const similarity = sql<number>`1 - (${builders.embedding} <=> ${queryEmbedding})`
  ```
- Implement a fallback mechanism: if the semantic query yields no results with similarity > 0.65, fall back to extracting noun-phrases from the query to perform keyword searches on external sources.

### Phase 4: UI Dashboard Toggle
- Add the "Semantic Search" slide/toggle component to `src/routes/_dashboard/search/index.tsx`.
- Create a visual feedback indicator showing similarity matching percentages (e.g., "94% Match").
- Style the cards with deep indigo/violet active highlights when in semantic mode.

### Phase 5: Verification & E2E Tests
- Write test scripts to seed mock developers with distinct profiles (e.g., a pure Rust developer, a pure design developer).
- Run queries like "who builds beautiful UI?" and assert that the design developer is returned with high similarity.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **pgvector extension missing on target PostgreSQL hosting** | Low | High | Document hosting requirements (standard Supabase, Neon, or local Docker support pgvector out of the box). |
| **API Costs / Quota exhaustion for embeddings** | Medium | Medium | Implement caching at the query level. Only generate embeddings once per builder profile unless their core bio/topics change. |
| **HNSW Index latency during build** | Low | Low | HNSW indices build slowly but query instantly. Only trigger index updates asynchronously. |

## Rollback plan

- Keep semantic search as an optional feature toggle.
- If the embedding API key is missing or fails, automatically disable the semantic search option in the UI and log a configuration warning.
