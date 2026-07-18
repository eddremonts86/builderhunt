# Tasks: AI Expansion Features (Detailed Checklist)

This document tracks the detailed, granular development tasks required to build the AI-Powered Semantic Search, AI Profile Enrichment, and Outreach Copilot features.

---

## Phase 1: Semantic Search Infrastructure (pgvector & Write-Through Cache)
This phase configures the pgvector extension and builds the hybrid local-external search pipeline.

- [ ] **Configure PostgreSQL pgvector Extension**
  * *What it is*: Enables vector similarity search in the Postgres database container.
  * *Details*:
    * Edit the development `Dockerfile` or `docker-compose.yml` to use a Postgres image containing the `pgvector` extension (e.g. `pgvector/pgvector:16`).
    * Create a database migration script containing:
      ```sql
      CREATE EXTENSION IF NOT EXISTS vector;
      ```
- [ ] **Extend Drizzle Builders Schema**
  * *What it is*: Adds the vector embedding column to the `builders` table.
  * *Details*:
    * Update `src/shared/lib/db/schema.ts` to export a custom `pgVector` type:
      ```ts
      const pgVector = customType<{ data: number[] }>({
        dataType() { return 'vector(768)' }
      });
      ```
    * Add `embedding: pgVector('embedding')` to the `builders` table definition.
    * Generate the migration files by executing `pnpm db:generate`.
- [ ] **Create HNSW Database Index**
  * *What it is*: Speeds up cosine similarity vector lookups.
  * *Details*:
    * Add an HNSW index migration to speed up query matching times:
      ```sql
      CREATE INDEX ON builders USING hnsw (embedding vector_cosine_ops);
      ```
    * Run `pnpm db:migrate` to apply migrations.
- [ ] **Build LLM Query Translator (`src/lib/search/query-translator.ts`)**
  * *What it is*: Service that translates natural language queries into API search keywords.
  * *Details*:
    * Build an LLM calling function using `Gemini 3.5 Flash`.
    * Prompt the LLM to output a list of keywords and filters from a search string (e.g., *"React canvas chart in Munich"* $\rightarrow$ keywords `["React", "canvas", "chart"]`, locations `["Munich"]`).
- [ ] **Implement Write-Through Indexing Cache Hook**
  * *What it is*: Intercepts search outputs and indexes them in background.
  * *Details*:
    * Modify the `searchBuilders` API route (`src/routes/api/search/builders.ts`).
    * For search results fetched dynamically from external APIs, check if the builder exists in local Postgres.
    * If not, save the profile record to the `builders` table.
    * Enqueue a background task to fetch the profile's text context and generate its 768-dimension embedding via Gemini API `text-embedding-004`.
- [ ] **Implement pgvector Cosine Similarity Query**
  * *What it is*: The local vector search function.
  * *Details*:
    * Build a query inside `src/lib/search.ts` that vectorizes the user query.
    * Query the local database using the Drizzle raw SQL helper for cosine distance similarity: `1 - (embedding <=> :queryEmbedding)`.
    * Order results by similarity score descending.
- [ ] **Add Semantic Search Frontend Toggle**
  * *What it is*: UI controls to activate vector search.
  * *Details*:
    * Add a toggle switch in `SearchPage.tsx` next to the search input.
    * When toggled ON, send the request to the backend indicating semantic mode.
    * Render a similarity match percentage badge (e.g., `92% match`) on developer result cards.

---

## Phase 2: AI Profile Enrichment (Developer Persona Bento Card)
This phase reads a candidate's code contributions on-demand and renders a structured persona summary.

- [ ] **Add JSONB Schema to Builders Table**
  * *What it is*: Schema column to store parsed persona details.
  * *Details*:
    * Add `aiEnrichment` JSONB property to the `builders` table inside `src/shared/lib/db/schema.ts`.
    * Include `aiEnrichedAt` (timestamp) to compute caching expiration.
- [ ] **Build Enrichment Service (`src/lib/agents/enricher.ts`)**
  * *What it is*: API service that compiles candidate information and prompts Gemini.
  * *Details*:
    * Build an aggregator function that pulls a developer's repository names, top languages, and blog posts.
    * Formulate a prompt querying Gemini to return structured JSON matching:
      ```ts
      interface BuilderAIEnrichment {
        summary: string;
        estimatedSeniority: 'Junior' | 'Mid' | 'Senior' | 'Lead';
        primaryFocus: string;
        strengths: string[];
        codingStyle: string;
      }
      ```
    * Implement Zod validation to ensure the LLM output matches this structure.
- [ ] **Build Persona Card Frontend UI**
  * *What it is*: Glassmorphism card displaying persona details.
  * *Details*:
    * Create `PersonaCard.tsx` inside `src/modules/builder-profile/components/`.
    * Style the card in light mode using a white card surface, subtle shadows, and esmerald/gold border highlights depending on seniority.
    * Implement a "Refresh AI card" button that triggers a manual API call to bypass the 30-day cache.

---

## Phase 3: Code-Contextual Outreach Generator (Outreach Copilot)
This phase designs a message editor panel that generates custom recruiting pitches referencing developers' repositories.

- [ ] **Implement Context Assembler (`src/lib/agents/outreach-context.ts`)**
  * *What it is*: Scrapes top repo files to feed the LLM pitch prompt.
  * *Details*:
    * Write a utility to fetch the candidate's top repository description, languages, and the raw text of their `README.md` file (truncated to 4,000 characters).
- [ ] **Build Outreach Generation Engine**
  * *What it is*: Gemini API call that drafts the pitch.
  * *Details*:
    * Prompt Gemini to write a recruiting message under 150 words.
    * Enforce strict negative guidelines prohibiting standard copy-paste recruiter clichés.
    * Set prompt guidelines for three tones: `casual` (lowercase, peer-to-peer), `professional` (formal), and `geek` (highly technical).
- [ ] **Build Outreach Copilot Side-Panel UI**
  * *What it is*: The slide-over message composer.
  * *Details*:
    * Create `OutreachCopilotPanel.tsx` in `src/modules/builder-profile/components/`.
    * Implement text input fields for target Job Title, Company Name, and Job Description.
    * Add a toggle control to select the Tone.
    * Render the draft in a styled box resembling an email composer, and add a "Copy to Clipboard" button with copy animations.
