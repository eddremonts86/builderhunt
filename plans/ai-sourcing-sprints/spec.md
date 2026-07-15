# Feature: AI Talent Sourcing Sprints

## Problem

Technical sourcing is historically passive and manual. Recruiters spend hours tweaking boolean queries on GitHub, reading individual bios, and cross-checking LinkedIn. This manual approach:
1. Is slow and does not scale (a search query only returns what's available at the moment of typing).
2. Misses high-potential developers who don't match exact keywords but have relevant code patterns in their repositories.
3. Lacks programmatic vetting (recruiters cannot manually inspect the code quality of 500 candidates).

## Goal

Provide a background-running Agentic Sourcing system ("Sourcing Sprints"). A recruiter defines a target developer persona in natural language (e.g. "We need a frontend developer who has built custom canvas charting libraries in React and is located in Germany"). 

The system will:
- Spawn an autonomous background worker (sourcing agent).
- Query multiple platforms sequentially (GitHub, GitLab, Devpost, Bluesky) over an extended window (e.g., 2 hours).
- Use LLMs to evaluate the code quality of found candidates (analyzing their code structure, naming conventions, and tests).
- Generate a curated technical dossier ("Sprint Report") of the top 10 matched candidates.

## Non-goals

- **No automated outbound messaging.** The agent only curates and screens candidates; it does not send emails autonomously to prevent spam reputation damage.
- **No real-time API blocking.** Sprints run asynchronously in the background.

## User stories

1. **As a recruiter**, I want to define a "Sourcing Sprint" by typing my requirements in a simple form, specifying search duration and regional preferences.
2. **As a recruiter**, I want to see a live visual progress indicator showing what the agent is currently doing (e.g. "Scanning GitHub repos...", "Analyzing code style for user @edd...").
3. **As a recruiter**, I want to receive an email notification when the sprint completes, linking to a detailed report containing candidate bios, code reviews, and relevance scores.

## Technical architecture

### 1. Database Schema
We introduce two new tables: `sourcing_sprints` and `sprint_results`.

```ts
export const sourcingSprints = pgTable('sourcing_sprints', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id),
  name: text('name').notNull(),
  prompt: text('prompt').notNull(), // natural language requirements
  durationMinutes: integer('duration_minutes').default(60),
  status: text('status').default('running'), // running | completed | failed
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
})

export const sprintResults = pgTable('sprint_results', {
  id: text('id').primaryKey(),
  sprintId: text('sprint_id').notNull().references(() => sourcingSprints.id, { onDelete: 'cascade' }),
  builderId: text('builder_id').notNull().references(() => builders.id),
  relevanceScore: integer('relevance_score').notNull(), // 0-100 score computed by LLM
  aiReview: text('ai_review').notNull(), // structured review explaining suitability
  createdAt: timestamp('created_at').defaultNow(),
})
```

### 2. Sourcing Agent Execution Loop
- The worker is triggered via a server action or background task runner.
- **Step 1 (Decomposition)**: An LLM analyzes the user prompt to generate API queries:
  - Keyword list for GitHub search.
  - Target languages and topics.
- **Step 2 (Data Gathering)**: Query sources (respecting rate limits with delays) and populate the database with matching builders.
- **Step 3 (Vetting)**: For the top 50 matches:
  - Fetch code samples (e.g. read files from their most popular repositories).
  - Call an LLM (Gemini 2.5 Flash) to grade the candidate on:
    - Code organization (0-10)
    - Test coverage & habits (0-10)
    - Architectural hygiene (0-10)
    - Match with prompt requirements (0-70)
- **Step 4 (Final Synthesis)**: Save the top 10 candidates to `sprint_results` and mark the sprint as `completed`.

## UX integration

- Create a `/sprints` page in the dashboard.
- **Sprint Creator Form**: Simple layout with text area for requirements and options for duration and candidates limit.
- **Progress Tracker View**: A dashboard section displaying active agents, log streams, and status charts.
- **Sprint Report View**: A layout displaying the top matching candidates with the AI-generated code reviews, alongside standard builder info.

## Success metrics

- **Efficiency**: Recruiters spend 90% less time searching and screening candidates, receiving high-relevance matches directly.
- **Conversion**: Candidates sourced through Sprints receive a 25% higher outreach response rate due to the precise relevance matching.
