# Implementation Plan: Unified AI Sourcing Workspace

This document outlines the step-by-step technical implementation phases for integrating the AI Sourcing Workspace in **BuilderHunt**.

---

## Phase 1: Dependencies & Database Schema Migration

### 1.1 Package Installation
Run the following package installations in the root directory:
```bash
pnpm add @edd_remonts/ai-schadcn-chat
pnpm dlx shadcn@latest add @shadcn-map/map
```

### 1.2 Schema Update
Add the Drizzle schema extensions inside `src/shared/db/schema.ts` (or corresponding database module files):
- Define `sourcingBatches` table.
- Define `sourcingSprints` table.
- Define `sprintResults` table.
- Export relations.

### 1.3 DB Migration
Generate and execute migrations:
```bash
pnpm db:generate
pnpm db:migrate
```

---

## Phase 2: Backend Logic & LLM Integrations (`src/lib/agents/`)

### 2.1 Batch Document Ingestion (`src/lib/agents/batch-analyzer.ts`)
- Implement PDF and Word text parsing helpers.
- Write parallel extraction scheduler:
  - Take an array of files.
  - Dispatch extraction queries to the Gemini API (using `Gemini 3.5 Flash`) in parallel (limit concurrency to 3 to respect rate limits).
  - Extract structured JSON tags (Skills, Locations, Experience Level, Roles).
  - Store results in `sourcing_batches`.

### 2.2 Search Variant Generator (`src/lib/agents/search-generator.ts`)
- Write an LLM generator that accepts aggregated batch tags and outputs 3 distinct Boolean query structures (Skills list + Location parameters + Seniority).
- Save generated variants linked to the active `sourcing_batches`.

### 2.3 Sourcing Worker & Vetting Loop (`src/lib/agents/sourcing-worker.ts`)
- Implement background runner that:
  - Takes a search variant.
  - Queries local DB matches.
  - Sequentially queries external APIs (GitHub, Devpost).
  - Feeds candidate profiles to the vetting engine (`vetting.ts`) to calculate suitability scores.
  - Populates `sprint_results`.

---

## Phase 3: Frontend Routes & Layout (`src/routes/_dashboard/sprints/`)

### 3.1 Workspace Router Setup
- Create `src/routes/_dashboard/sprints/workspace.tsx` as a TanStack route.
- Define state context:
  ```ts
  interface WorkspaceState {
    step: 1 | 2 | 3 | 4;
    batchId: string | null;
    activeVariant: string | null;
    selectedVariants: string[];
    filters: SearchFilters;
  }
  ```

### 3.2 Chat Sidebar Component (`@edd_remonts/ai-schadcn-chat`)
- Implement collapsible left panel.
- Sync message history to the current workspace session.
- Implement callbacks to toggle candidate highlight state and location zooming on the map.

### 3.3 Main Dashboard Views (1 -> 2 -> 3 -> 4)
- **Step 1 View (Upload & Queue)**: Dropzone component + uploading/processing list with progress rings.
- **Step 2 View (Variants Generator)**: Interactive tag cloud + checkbox list of suggested variant cards.
- **Step 3 View (Active Sprints)**: Dual pane progress dashboard with status bars and console logs.
- **Step 4 View (Results Map)**: Split screen. Left shows candidate list with circular match rings. Right shows the `@shadcn-map/map` Canvas/Leaflet instance.

---

## Phase 4: Verification & Quality Gates

### 4.1 Unit Testing (`test/sprints/`)
- Mock Gemini API responses for document tag extraction and variant generation.
- Test `batch-analyzer.ts` parallel scheduling execution under concurrent pressure.
- Test boolean parser and criteria aggregators.

### 4.2 Integration Verification
- Drag 5 sample resumes (PDF) into Step 1.
- Confirm tags compile correctly and suggest variants in Step 2.
- Execute search, and verify pins render with accurate latitude/longitude coordinates on the map in Step 4.
