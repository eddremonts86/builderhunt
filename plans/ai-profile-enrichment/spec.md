# Feature: AI Profile Enrichment

## Problem

BuilderHunt displays a aggregated list of a developer's repositories, articles, and posts. However, digesting this raw information is time-consuming for recruiters or collaborators:
1. They must click through multiple links to understand a candidate's actual specialty and level.
2. Raw GitHub repository lists often do not communicate the developer's core strengths, coding style, or architectural preferences.
3. Bios are frequently empty, generic, or outdated, failing to reflect the developer's current focus.

## Goal

Automatically enrich developer profiles using a Generative AI pipeline. When a profile is viewed or claimed:
- Aggregate their raw data (bios, top repos, recent blog posts, social posts).
- Prompt an LLM (such as Gemini 2.5 Flash) to generate a structured, objective summary of the developer's technical profile.
- Store this summary in the builder's metadata and render a "Developer Persona Card" in the user interface.

## Non-goals

- **No automated vetting or screening grading.** We do not rate developers on a standard numeric performance scale (which is subjective and prone to hallucination); we only summarize their public work and style objectively.
- **No live enrichment on index search views.** We only trigger the enrichment when a user clicks a profile's detail view, or asynchronously when a profile is claimed.

## User stories

1. **As a user**, in the builder detail sheet, I want to see an "AI Overview" section summarizing the builder's main technical focus in 2-3 concise sentences.
2. **As a user**, I want to see a checklist of "Core Strengths" and "Estimated Seniority" generated from their public code and writing contributions.
3. **As a builder**, when I claim my profile, I want the system to trigger a fresh AI profile summary to ensure it reflects my latest achievements.

## Technical architecture

### 1. Data Aggregation
- When enrichment is triggered for `builderId`:
  - Fetch the builder record from the database.
  - Compile a text payload containing:
    - Primary language and country.
    - Topics list.
    - Repository names, descriptions, languages, and star counts (from metadata).
    - Recent blog post titles and summaries (from Dev.to/Hashnode metadata).
    - Recent social post texts (from Bluesky/HN metadata).

### 2. LLM Prompting & Schema Verification
- Send the payload to the Gemini API (`gemini-2.5-flash` or similar endpoint) with a system instruction enforcing structured JSON output.
- Target JSON structure:
  ```json
  {
    "summary": "String (2 sentences max)",
    "estimatedSeniority": "Junior | Mid | Senior | Lead",
    "primaryFocus": "String (e.g. Backend Architecture, Interactive UI)",
    "strengths": ["String", "String", "String"],
    "codingStyle": "String (brief description of patterns used, e.g. TDD, functional, performance-first)"
  }
  ```

### 3. Storage
- Save the structured response in the `builders` table under the `metadata.aiEnrichment` JSONB property.
- Save a timestamp `metadata.aiEnrichedAt` to manage cache expiration (e.g., refresh every 30 days).

## Data shape

Stored directly in the `builders.metadata` JSONB column. Schema type helper:

```ts
export interface BuilderAIEnrichment {
  summary: string
  estimatedSeniority: 'Junior' | 'Mid' | 'Senior' | 'Lead'
  primaryFocus: string
  strengths: string[]
  codingStyle: string
  enrichedAt: number
}

// Stored in `builders.metadata.aiEnrichment`
```

## UX integration

- Implement a "Developer Persona" bento card in the builder detail view.
- Design: High-end glassmorphism card styled with a soft gold/emerald border highlight (`#10b981` to `#fbbf24`) depending on the seniority estimation.
- Include a "Refresh AI Card" button (available to the claimed profile owner or admins).

## Success metrics

- **Readability**: Recruiters understand a builder's technical focus under 10 seconds of landing on their profile sheet.
- **Engagement**: Profile detail page retention increases, with users expanding the "Coding Style" details card in >40% of page views.

## Open questions

- **How do we handle empty profiles (no repos, no posts)?**
  - *Recommendation*: Skip calling the LLM entirely if the builder has no public repositories or activity posts. Render a placeholder: "Not enough public activity to generate AI Persona Card."
- **LLM Cost Mitigation**: How do we prevent runaway API costs?
  - *Recommendation*: Only run enrichment on demand (lazy loading when detail view is opened, cached for 30 days) rather than bulk-processing every search result.
