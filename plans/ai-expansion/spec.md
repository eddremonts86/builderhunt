# Feature Specification: AI Expansion Features (Semantic Search, Profile Enrichment & Outreach Copilot)

This document specifies the technical design, data flows, and architectures for the next three AI-driven modules in **BuilderHunt**:
1. **AI-Powered Semantic Search (pgvector + Write-Through Cache)**
2. **AI Profile Enrichment (Developer Persona Bento Card)**
3. **Code-Contextual Outreach Generator (Outreach Copilot)**

---

## 1. AI-Powered Semantic Search (pgvector + Write-Through Cache)

### Problem & Objective
Since BuilderHunt operates as a federated search engine (querying external APIs like GitHub, HN, and Dev.to in real-time without caching profiles permanently), a pure local database search would return zero results at launch. 
The objective is to implement a **hybrid write-through vector cache** that grows organically as users perform searches.

### Data Flow & Execution Sequence
1. **User Search Query**: The user searches using a natural language phrase (e.g. *"React canvas charting library developer in Germany"*).
2. **Local Vector Search**:
   * Vectorize the query using the Gemini API `text-embedding-004` (768 dimensions).
   * Query the local Postgres database using `pgvector` and HNSW indexing for matches with Cosine Similarity > `0.70`.
   * If $\ge$ 10 high-relevance matches are found, display them.
3. **Dynamic API Fallback (Traducción de Consulta)**:
   * If local results are insufficient, run a lightweight Gemini model to translate the semantic phrase into search tokens:
     * *Input*: *"React canvas charting library developer in Germany"*
     * *Output*: `{ keywords: ["React", "canvas", "chart", "graph"], language: "TypeScript", country: "Germany" }`
   * Execute the federated API search against GitHub, Hacker News, Dev.to, etc.
   * Render results to the user.
4. **Write-Through & Embedding Generation**:
   * Insert the newly retrieved profiles into the local `builders` database table.
   * Enqueue a background job to calculate their 768-dimension vector embeddings and save them inside the `embedding` column.

### Database Changes
```ts
// Drizzle Schema Addition in `src/shared/lib/db/schema.ts`
import { customType } from 'drizzle-orm/pg-core'

// Define the 768-dimension pgvector type for Drizzle
const pgVector = customType<{ data: number[] }>({
  dataType() {
    return 'vector(768)'
  },
})

// Update builders table definition:
export const builders = pgTable('builders', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  username: text('username').notNull(),
  bio: text('bio'),
  topics: text('topics').array(), // tech skills
  embedding: pgVector('embedding'), // semantic search vector
  createdAt: timestamp('created_at').defaultNow(),
})
```

---

## 2. AI Profile Enrichment (Developer Persona Card)

### Objective
Summarize developers' code footprints, stars, and posts into a structured Persona Card, saving recruiters from reading raw lists of repositories.

### Pipeline Logic
* **On-Demand (Lazy Loading)**: To minimize Gemini API costs, enrichment is only triggered when a recruiter clicks to view a developer's details or when a profile is claimed.
* **Cache Management**: Results are stored in the database in JSONB format inside `builders.metadata.aiEnrichment`. We store `metadata.aiEnrichedAt` to manage cache expiration (30-day TTL).

### Data Shape
```ts
export interface BuilderAIEnrichment {
  summary: string;                  // 2-sentence synthesis of work
  estimatedSeniority: 'Junior' | 'Mid' | 'Senior' | 'Lead';
  primaryFocus: string;             // e.g. "WebGL rendering & Canvas optimizations"
  strengths: string[];              // e.g. ["WebGL", "Performance Tuning", "TypeScript"]
  codingStyle: string;              // e.g. "Clean functional programming, TDD"
  enrichedAt: number;               // Epoch timestamp
}
```

---

## 3. Code-Contextual Outreach Generator (Outreach Copilot)

### Objective
A recruiting copywriting utility that reads a candidate's code repositories and commits, matching them against a recruiter's job description to generate a highly personalized outreach message.

### Prompting Strategy
* **Anti-Cliche Enforcement**: The model is prompted with negative rules preventing recruiters' clichés (e.g. *"I'm impressed by your profile"*, *"exciting opportunity"*).
* **Reference Hook**: The draft *must* start by referencing a specific open-source project or repository from the candidate (e.g. *"I was looking at your fractal-gen canvas rendering repository..."*) and explain *why* that proves suitability for the position.
* **Tone Settings**:
  * `Casual Developer`: Lowercase, conversational, peer-to-peer.
  * `Professional`: Capitalized, polite, business-oriented.
  * `Technical Deep Dive`: Advanced jargon, asking architectural questions.
