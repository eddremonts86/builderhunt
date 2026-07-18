# Tasks: Unified AI Sourcing Workspace (Detailed Specification)

This document provides a highly detailed, granular breakdown of all technical tasks required to implement the Unified AI Sourcing Workspace in **BuilderHunt**.

---

## Phase 1: Database Setup & Migrations
This phase establishes the relational data structures required to trace multi-file batch uploads, asynchronous background sourcing runs, and geographic developer results.

- [ ] **Create Database Schema Migrations**
  * *What it is*: Define Drizzle schemas for batch tracking and candidate sourcing results.
  * *Details*:
    * Edit `src/shared/lib/db/schema.ts` (or equivalent database schema files).
    * Add `sourcingBatches` table:
      * `id`: `text` (primary key, UUID or nanoid).
      * `userId`: `text` (foreign key referencing `authUsers.id`).
      * `status`: `text` (defaults to `'processing'`, can be `'processing' | 'complete' | 'failed'`).
      * `createdAt`: `timestamp` (defaults to `now()`).
      * `completedAt`: `timestamp` (nullable).
    * Add `sourcingSprints` table:
      * `id`: `text` (primary key).
      * `batchId`: `text` (foreign key referencing `sourcingBatches.id` with `onDelete: 'cascade'`).
      * `userId`: `text` (foreign key referencing `authUsers.id`).
      * `name`: `text` (name of the sprint).
      * `prompt`: `text` (raw prompt / criteria text).
      * `status`: `text` (defaults to `'running'`, can be `'running' | 'completed' | 'failed'`).
      * `createdAt`: `timestamp` (defaults to `now()`).
      * `completedAt`: `timestamp` (nullable).
    * Add `sprintResults` table:
      * `id`: `text` (primary key).
      * `sprintId`: `text` (foreign key referencing `sourcingSprints.id` with `onDelete: 'cascade'`).
      * `builderId`: `text` (foreign key referencing `builders.id` with `onDelete: 'cascade'`).
      * `relevanceScore`: `integer` (suitability match score, 0-100).
      * `aiReview`: `text` (structured markdown review details from code vetting).
      * `createdAt`: `timestamp` (defaults to `now()`).
- [ ] **Generate and Run Schema Migrations**
  * *What it is*: Run Drizzle-kit commands to apply schema additions locally.
  * *Details*:
    * Run `pnpm db:generate` to produce SQL migration files under `drizzle/`.
    * Run `pnpm db:migrate` to update the local Postgres database container.

---

## Phase 2: Batch Ingestion & Parallel Extraction (`src/lib/agents/`)
This phase builds the background processing engine that parses uploaded PDF/Word resumes or pasted profile URLs, querying Gemini in parallel to extract structured search criteria.

- [ ] **Implement Document Text Parsers**
  * *What it is*: Utilities to extract raw text content from uploaded files.
  * *Details*:
    * Build helper functions inside `src/lib/agents/parsers.ts`.
    * For `.pdf`: extract text pages.
    * For `.docx`: parse document XML contents.
    * For `.txt`: read file string buffer.
- [ ] **Implement URL Scraper Utility**
  * *What it is*: Helper to fetch and clean profile data from submitted URLs.
  * *Details*:
    * Implement a scraper inside `src/lib/agents/url-scraper.ts` that takes an external link (LinkedIn, GitHub, personal portfolio, or job board description).
    * Strip HTML tags, formats content, and handles fallback errors.
- [ ] **Build Parallel Processing Queue with Concurrency Limit**
  * *What it is*: Scheduler in `src/lib/agents/batch-analyzer.ts` that runs concurrent API requests without triggering rate limits.
  * *Details*:
    * Define a queue function that receives an array of file buffers/URLs.
    * Set a strict concurrency ceiling (e.g. maximum of 3 concurrent requests at any single moment).
    * Execute parsing sequentially or in small chunks using a promise wrapper to prevent GitHub/Gemini API blockages.
- [ ] **Design LLM Tag Extraction Prompt**
  * *What it is*: Gemini API call that translates raw parsed text into structured search JSON.
  * *Details*:
    * Call `Gemini 3.5 Flash`.
    * Inject system prompt instructions to return strict JSON matching this schema:
      ```ts
      interface ExtractedCriteria {
        skills: string[]; // programming languages, frameworks, UI/UX tools
        locations: string[]; // target locations mentioned
        experienceLevel: 'junior' | 'mid' | 'senior';
        roles: string[]; // job titles matching
      }
      ```
    * Implement JSON parsing validation using `zod` to catch malformed LLM outputs.
- [ ] **Batch Status Database Updater**
  * *What it is*: Functions to update database task states during extraction.
  * *Details*:
    * Create a record in `sourcing_batches` at the start.
    * Update states of individual files in the batch. Set batch status to `'complete'` once all files are successfully processed and tags are saved.

---

## Phase 3: Tag Cloud & Multi-Variant Generator (`src/lib/agents/`)
This phase aggregates the criteria extracted from the files and triggers the LLM to suggest targeted search strategies.

- [ ] **Implement Tag Aggregation Logic**
  * *What it is*: An algorithm that consolidates extracted JSON data.
  * *Details*:
    * Retrieve all `ExtractedCriteria` records belonging to a specific `batch_id`.
    * Consolidate skills, locations, and roles.
    * Compute occurrences frequency for each tag (e.g., `"React"` appears 6 times, `"Munich"` appears 2 times).
    * Output sorted lists to display on the dashboard tag cloud.
- [ ] **Build LLM Search Variant Generator**
  * *What it is*: Gemini API call that parses aggregated tags and formulates 3 distinct search profiles.
  * *Details*:
    * Prompt the LLM with the aggregated frequencies.
    * Ask the LLM to generate 3 search variants. Each variant must output:
      * `name`: String (e.g., "Senior React Developers in Germany").
      * `skills`: String array (representing target skills to match).
      * `locations`: String array (representing locations to search).
      * `experienceLevel`: `'junior' | 'mid' | 'senior'`.
      * `justification`: String (explaining the rationale based on the input documents).
    * Store these variant profiles in the DB linked to the `batch_id` for retrieval in Step 2 of the UI.

---

## Phase 4: Sourcing Workers & Dual Execution (`src/lib/agents/`)
This phase handles the sourcing run—executing local database queries and triggering background agents to scan external developer platforms.

- [ ] **Implement Local Database Matcher**
  * *What it is*: A Drizzle database query that finds matching developers already registered in BuilderHunt.
  * *Details*:
    * Query the `builders` table matching the selected variant's `skills` and `locations`.
    * Calculate a baseline matching score in SQL/TS based on matched criteria.
- [ ] **Implement Background External Sourcing Loop**
  * *What it is*: Asynchronous worker loops inside `src/lib/agents/sourcing-worker.ts` that scan APIs.
  * *Details*:
    * Build search request triggers for:
      * **GitHub**: Scan user repositories using GitHub search endpoints, filtering by skills (topics, languages) and locations.
      * **Devpost**: Scan participants and projects matching the search topic.
    * Implement a 2-second sleep delay helper between external API calls to avoid rate limiting.
- [ ] **Implement Candidate Code Vetting Engine**
  * *What it is*: Vetting engine in `src/lib/agents/vetting.ts` that grades candidate repositories using the LLM.
  * *Details*:
    * For the top 50 candidates found externally, fetch their profile `README.md` and the top 3 source code files in their popular repos (max 4,000 characters per file).
    * Send the code content to `Gemini 3.5 Flash` with a structured grading rubric:
      * Code organization (0-10)
      * Test habit & habit detail (0-10)
      * Architectural hygiene (0-10)
      * Match with requirements (0-70)
    * Save new developer profiles in the `builders` table and insert vetting scores and summaries in `sprint_results`.
- [ ] **Implement Worker Logging Stream**
  * *What it is*: Helper to record and stream active search operations.
  * *Details*:
    * Write logs to a text field or sub-table in the database during worker loops (e.g. *"Scanned Devpost hackathon X, found 4 matches"*).
    * Expose an endpoint or TanStack query function to stream these logs to the Step 3 UI.

---

## Phase 5: Workspace Frontend Routes & UI (`src/routes/_dashboard/sprints/`)
This phase builds the interactive dashboard workspace in React, integrating the map and chat packages.

- [ ] **Install and Configure Library Packages**
  * *What it is*: Pull dependencies into the project.
  * *Details*:
    * Run `pnpm add @edd_remonts/ai-schadcn-chat`
    * Run `pnpm dlx shadcn@latest add @shadcn-map/map`
- [ ] **Create TanStack Router File & Global State Provider**
  * *What it is*: Set up router and state contexts for the workspace.
  * *Details*:
    * Create `src/routes/_dashboard/sprints/workspace.tsx`.
    * Define a React context to manage active steps (`1 | 2 | 3 | 4`), batch IDs, active variants, selected variants, and search filters.
- [ ] **Implement Step 1 View: Batch Ingestion UI**
  * *What it is*: File upload and progress monitoring screen.
  * *Details*:
    * Build a drag-and-drop file upload zone.
    * Build a URL paste text area.
    * Render a table of active files showing file names, sizes, processing statuses (`'parsing' | 'extracting' | 'complete'`), and circular progress indicators.
- [ ] **Implement Step 2 View: Variant Selector UI**
  * *What it is*: Tag cloud visualization and variant picker screen.
  * *Details*:
    * Render the aggregated tag clouds grouped by category with terracotta-styled frequency pills.
    * Render 3 columns/cards displaying the AI search variants (Variant Name, Skills, Locations, Justification) with checkboxes to select them.
- [ ] **Implement Step 3 View: Progress Monitor UI**
  * *What it is*: Real-time sourcing logs screen.
  * *Details*:
    * Render a split view:
      * Left: Real-time Database Matches (profiles loaded dynamically from the local DB matching query).
      * Right: Background Sprints Progress (bars tracking GitHub/Devpost scans, terminal console displaying status logs).
- [ ] **Implement Step 4 View: Geographic Results UI**
  * *What it is*: The final split screen displaying lists and the map.
  * *Details*:
    * Left side: Scrollable list of candidate cards. Each card displays suitability scores in custom circular SVG progress rings.
    * Right side: `@shadcn-map/map` canvas showing map coordinates with location marker pins.
- [ ] **Integrate `@edd_remonts/ai-schadcn-chat` Sidebar**
  * *What it is*: Fixed chat panel integrated into the workspace.
  * *Details*:
    * Place the chat component inside a fixed `320px` left panel.
    * Connect callbacks so that:
      * When the AI chat suggests a candidate, clicking that bubble highlights the candidate on the list and centers the map.
      * The user can query list results in natural language (e.g. *"Who has React experience?"*), which updates filters on the list and map dynamically.

---

## Phase 6: Verification & Testing
This phase handles the testing of code correctness and E2E behavior.

- [ ] **Write Unit Tests for Parallel Scheduler**
  * *What it is*: Tests ensuring the batch parser works under pressure.
  * *Details*:
    * Create `test/sprints/batch-analyzer.test.ts`.
    * Mock the Gemini API and document text parsers.
    * Assert that parallel uploads containing 10 files execute concurrently while honoring the ceiling limits.
- [ ] **Write Integration Tests for Boolean Query Aggregator**
  * *What it is*: Tests validating search variant generation.
  * *Details*:
    * Write tests ensuring tag frequencies are correctly sorted.
    * Verify that Zod validates the LLM JSON response successfully.
- [ ] **Manual End-to-End Verification**
  * *What it is*: Live test upload of sample resumes.
  * *Details*:
    * Upload 5 sample developer resume PDFs.
    * Confirm that Step 2 successfully generates tags.
    * Confirm that Step 4 displays candidates positioned on the map with correct Leaflet coordinates.
