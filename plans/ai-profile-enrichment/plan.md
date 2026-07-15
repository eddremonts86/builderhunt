# Plan: AI Profile Enrichment

## Goal recap

Add an AI-driven profile enrichment engine to BuilderHunt that summarizes developer profiles, extracts strengths, and styles an elegant "Developer Persona Card" using LLM structured outputs.

## Why this is a valuable addition

1. **Instant Clarity**: Going through hundreds of git commits and repositories is tedious. An objective AI summary acts as a strong initial filter for profile screening.
2. **Interactive UI**: A beautifully designed "Persona Card" makes BuilderHunt look highly polished and premium, separating it from standard raw API aggregators.
3. **Low-latency rendering**: Since results are cached directly inside the `builders` table's JSONB `metadata` column, subsequent views load instantaneously.

## Phases

### Phase 1: LLM Client Setup & Prompts (`src/lib/ai/enrich.ts`)
- Implement a wrapper for the Gemini API using official Google AI SDK (`@google/genai` or fetch client).
- Read the API credentials: `GEMINI_API_KEY`.
- Design a specialized system prompt enforcing a strict JSON output matching our schema.
- Write unit tests validating prompt output handling.

### Phase 2: Server Action & Trigger Handler
- Write a TanStack Start Server Function `enrichBuilderProfile({ builderId })`.
- Within the function:
  - Assert authentication (only logged-in users can trigger or load profiles).
  - Verify if `metadata.aiEnrichment` exists and is younger than 30 days. If so, return cached data.
  - Compile developer activity payload.
  - Call the LLM service.
  - Save the response inside the `builders` database row.

### Phase 3: Dashboard Profile Details Integration
- Update `src/routes/_dashboard/builder/$id.tsx` to call the server function during page load.
- Show a skeleton loading loader with an AI animation spinner while generating.
- Build the "Developer Persona Bento Card" layout in the UI:
  - Gradient borders.
  - Strengths rendered as pill chips.
  - Seniority displayed with distinctive brand tags.

### Phase 4: Verification & Limits
- Mock the Gemini API in testing files.
- Test edge cases where profiles have:
  - Very large payload (truncate input to fit 4,000 tokens limit).
  - Minimal public data (return a default empty persona without calling the API).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **LLM Hallucinations (e.g. estimating wrong seniority)** | High | Medium | Label the card clearly as "AI-Generated Summary" and display a disclaimer. Allow claimed profile owners to request a rerun. |
| **Runaway API costs** | Medium | High | Apply a strict daily quota (e.g. max 5 profile enrichments per user per day). Cache outcomes for 30 days. |
| **API Timeout / Latency** | Medium | Medium | Fetch enrichment asynchronously. Load the main profile data immediately, and lazy-load the AI card once the API responds. |

## Rollback plan

- Control the feature via the `ENABLE_AI_ENRICHMENT=false` flag.
- If disabled, the UI profile page hides the "AI Overview" block entirely and displays the raw repository list as before.
