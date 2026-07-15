# Feature: AI-Powered Semantic Search

## Problem

BuilderHunt currently searches profiles using exact keyword matches (e.g. splitting search terms and querying external APIs). This keyword-based matching is fragile:
1. It misses candidates who use synonymous terms (e.g. searching "frontend developer" might miss a profile describing themselves as "UI/UX engineer building web apps in React").
2. It cannot process intent-based or natural language queries (e.g. searching "experienced developer who builds scalable databases in Rust" returns poor results or zero hits on raw keywords APIs).
3. It relies heavily on external search APIs that have strict query rate limits.

## Goal

Implement semantic vector search in BuilderHunt. This will allow:
- Users to search for developers using descriptive, natural language queries.
- Storing developer profiles locally in PostgreSQL and indexing them using the `pgvector` extension.
- Generating vector embeddings of profiles based on their bio, tech stack, and recent activity, and querying them using cosine similarity.

## Non-goals

- **No vector indexing of the entire external internet.** We only generate embeddings for builders that are saved in our local database (e.g. builders found during searches, claimed profiles, or pre-indexed popular developers).
- **No training of custom embedding models.** We use off-the-shelf embedding APIs (e.g., Gemini's `text-embedding-004` or local Ollama endpoints with `nomic-embed-text`).

## User stories

1. **As a user**, I want to search for "senior web dev with design taste" and find profiles matching this description, even if their bios do not contain those exact words.
2. **As a user**, I want a toggle switch "Semantic Search" next to the search input.
3. **As a user**, I want search results to show a "similarity score" (percentage match) when semantic search is active.

## Technical architecture

### 1. Database Upgrade
- Install the `pgvector` extension in PostgreSQL.
- Add an `embedding` vector column to the `builders` table:
  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE builders ADD COLUMN embedding vector(768); -- 768 dimensions for Google / local models
  CREATE INDEX ON builders USING hnsw (embedding vector_cosine_ops); -- HNSW index for fast similarity search
  ```

### 2. Embedding Pipeline
- When a builder profile is created or updated:
  - Generate a text document representing the builder's profile:
    ```
    Name: [displayName] (@[username])
    Bio: [bio]
    Technologies: [topics / language]
    Metadata: [public repositories, organization, recent posts highlights]
    ```
  - Call the embedding model (Gemini API or local Ollama client) to compute the 768-dimension vector.
  - Save the vector into the `embedding` column in the `builders` table.

### 3. Query Flow
- When a semantic search is triggered:
  - Generate the embedding vector of the user's query.
  - Query the database using Drizzle ORM or raw SQL:
    ```sql
    SELECT id, display_name, bio, topics, 1 - (embedding <=> :queryEmbedding) AS similarity
    FROM builders
    WHERE 1 - (embedding <=> :queryEmbedding) > 0.65
    ORDER BY similarity DESC
    LIMIT :limit;
    ```
  - If local matches are too few, extract keyword tokens from the natural language query using a lightweight parser and trigger a background query to external APIs to discover new builders, index them, and add them to the results.

## Data shape

We update the existing `builders` schema inside `src/shared/lib/db/schema.ts` to include:

```ts
// Drizzle Schema Addition
import { customType } from 'drizzle-orm/pg-core'

const vector = customType<{ data: number[] }>({
  dataType() {
    return 'vector(768)'
  },
})

// In builders table definition:
export const builders = pgTable('builders', {
  // ... existing fields ...
  embedding: vector('embedding'),
})
```

## UX integration

- Implement a toggle button "Semantic Search" on the dashboard search bar.
- When active, show a similarity badge (e.g. `92% match`) next to the developer's cards instead of the standard metric score.
- Color theme: Gradient indigo/violet to signal AI capability (`#6366f1` / `#a855f7`).

## Success metrics

- **Relevance**: Cosine similarity matches return developers who align with the conceptual queries.
- **Search speed**: Local database HNSW search operates under 50ms, compared to API-based searches taking 1.5s+.

## Open questions

- **How do we handle cold-start?** Since vector search only queries our local database, a fresh deployment will return zero matches.
  - *Recommendation*: Implement a "proactive discovery background worker" (already planned in `plans/proactive-discovery`) to search popular keywords on GitHub/GitLab and populate the database with a baseline set of 10,000+ top builders.
