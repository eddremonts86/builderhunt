# Implementation Plan: AI Expansion Features

This plan details the implementation phases for the AI-Powered Semantic Search, AI Profile Enrichment, and Outreach Copilot in **BuilderHunt**.

---

## Phase 1: Semantic Search Infrastructure (pgvector & Write-Through Cache)

### 1.1 Database Extension & Schema
- Install `pgvector` in the Postgres Docker Compose file configuration or script.
- Add database migration generating the HNSW index on the `builders.embedding` vector column.
- Update the Drizzle schema in `src/shared/lib/db/schema.ts` to export the `vector` custom type.

### 1.2 Translation Engine & Sourcing Hook
- Create `src/lib/search/query-translator.ts` to translate semantic natural language search strings into array keywords.
- Implement the "Write-Through Indexing Cache" hook inside `src/routes/api/search/builders.ts`:
  - Intercept federated search results.
  - Write new builder profiles to the database.
  - Queue background jobs to fetch and generate vector embeddings asynchronously.

### 1.3 Semantic Query Handler
- Write the database query utilizing the cosine similarity operator (`<=>`) to fetch matching vectors.
- Implement similarity score percentage calculations in the frontend results view.

---

## Phase 2: AI Profile Enrichment (Persona Bento Card)

### 2.1 Schema & Cache Utilities
- Add `aiEnrichment` JSONB property to the `builders` database schema.
- Write cache verification functions to validate if a profile requires a refresh based on `aiEnrichedAt` (30-day TTL).

### 2.2 Enrichment Prompt & Service (`src/lib/agents/enricher.ts`)
- Implement text content aggregator (reading languages, repo descriptions, recent posts metadata).
- Build the Gemini prompt using structured JSON schema output to guarantee consistency.

### 2.3 Profile Bento Card UI
- Create `PersonaCard.tsx` component inside `src/modules/builder-profile/components/`.
- Design a glassmorphism card matching the warm light-mode cream/terracota palette.
- Add "Refresh AI Details" action button on the profile page.

---

## Phase 3: Code-Contextual Outreach Generator (Outreach Copilot)

### 3.1 Context Assembler
- Write repository code analyzer helper `src/lib/agents/outreach-context.ts` that selects the candidate's top repository and reads its `README.md` file.

### 3.2 Outreach Copilot Engine
- Create the Gemini model caller, configuring system instructions to write short pitches referencing the top repository.
- Support tone parameters: `casual`, `professional`, and `geek`.

### 3.3 Composer UI Panel
- Build `OutreachCopilotPanel.tsx` in `src/modules/builder-profile/components/`.
- Implement a slide-over panel showing job description text inputs, tone toggle select switches, and a copy-to-clipboard button.
