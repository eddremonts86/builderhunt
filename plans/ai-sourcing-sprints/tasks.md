# AI Sourcing Sprints (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md) (hard — tenant persistence, budgets, worker context, and RLS); [`ai-expansion`](../ai-expansion/tasks.md) (hard); [`semantic-search`](../semantic-search/tasks.md) (optional adapter); [`proactive-discovery`](../proactive-discovery/tasks.md) (pattern only); [`team-accounts`](../team-accounts/tasks.md) and [`shared-resources`](../shared-resources/tasks.md) (Future sharing only)
> **Blocks**: nothing
> **Reality check**: No sprint files exist. Reuse the real federated orchestrator, tracked-state helpers, billing gates, and admin-worker route; do not add fictional packages, Gemini server calls, Devpost, map/geocoding, or writes to per-user `builders`.

Ordered so each checkpoint builds and the feature can be rolled out incrementally.

## Phase 1 — Contracts and tasks

- [ ] **Define sprint contracts and deterministic fallbacks**
  - Files: `src/shared/lib/sprints-shared.ts`, `src/shared/lib/sprints-shared.test.ts`
  - Do: Export the spec's `ExtractedCriteria`, `QueryVariant`, `SprintFilter`, `SprintProfileSnapshot`, create/update schemas, status enum, response DTOs, `manualCriteriaToVariant`, and strict `SOURCE_NAMES` validation. Bound all strings/arrays and strip no unknown fields silently.
  - Verify: `pnpm test sprints-shared` covers valid/invalid sources, maxima, fallback output, and unknown-key rejection.

- [ ] **Register the three local-first AI tasks**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: Add `jd-parse`, `criteria-decompose`, and `filter-refine` with the exact schemas, TTLs, allowances, and token limits in spec.md. `jd-parse` uses `wrapUntrusted`; all three declare `tier: 'local-first'` and return strict JSON.
  - Verify: `pnpm test tasks` proves registry integrity and malicious delimiter text remains data.

## Phase 2 — Persistence and billing

- [ ] **Add sprint tables and indexes**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `sourcingSprints` and `sprintResults` exactly as in spec.md. Add indexes on `(userId, status, lastRunAt)`, `(sprintId, createdAt)`, and unique `(sprintId, source, sourceId)`. Use timezone-aware timestamps and JSON types imported from `sprints-shared.ts`; no FK to `builders`.
  - Verify: `pnpm type-check`.

- [ ] **Generate and apply the additive migration**
  - Files: `drizzle/` (generated migration and snapshot)
  - Do: Run `pnpm db:generate`, review for two creates/indexes only, then migrate a fresh local DB.
  - Verify: `pnpm db:migrate`; psql shows both tables, cascade from sprint to results, and the unique identity index.

- [ ] **Add the active-sprint plan limit**
  - Files: `src/shared/lib/billing-shared.ts`, `src/shared/lib/billing.ts`, `src/shared/lib/billing.test.ts`
  - Do: Add `sourcingSprints` limits `{ free: 0, pro: 3, team: 10 }`, count only `status = 'active'`, and add Pro/Team pricing copy. Keep preview outside this persistence limit.
  - Verify: `pnpm test billing` covers 0/at/over limit and paused/completed exclusions.

## Phase 3 — Domain and worker

- [ ] **Build snapshot/result helpers**
  - Files: `src/lib/sprints/results.ts`, `src/lib/sprints/results.test.ts`
  - Do: Implement `toSprintProfileSnapshot`, stable `source:sourceId` identity, quota clipping, location facets with an `Unknown` bucket, sort/filter helpers, and tracked annotation using `trackedKey`/`getTrackedBuilderIds` conventions.
  - Verify: `pnpm test sprints/results` covers private-field stripping, duplicates, quota boundaries, facets, and tracked IDs.

- [ ] **Build owner-scoped sprint service**
  - Files: `src/lib/sprints/service.ts`, `src/lib/sprints/service.test.ts`
  - Do: Implement list/get/create/update/delete and pause/resume transitions. Every query scopes by `userId`; resume rechecks the active limit; completed cannot resume; delete cascades. Use injected DB/search dependencies in tests.
  - Verify: `pnpm test sprints/service` includes a second user's sprint ID returning not found and every invalid transition returning conflict.

- [ ] **Implement cursor and worker core**
  - Files: `src/lib/sprints/worker.ts`, `src/lib/sprints/worker.test.ts`
  - Do: Export pure `nextSprintCursor`; lease at most three oldest due active sprints with `FOR UPDATE SKIP LOCKED`; execute one variant/page cell (`page <= 3`, `perPage: 30`), keep people only, insert snapshots on conflict-do-nothing, clip at quota, and compare-and-set the leased cursor before advancing. A cell error leaves its cursor unchanged and is reported without aborting peers.
  - Verify: `pnpm test sprints/worker` covers wrap/completion, duplicate rerun, overlap, partial upstream failure, downgrade skip, and quota hit.

- [ ] **Add optional semantic write-through adapter**
  - Files: `src/lib/sprints/semantic-write-through.ts`, `src/lib/sprints/worker.ts`
  - Do: When semantic-search exists, adapt sprint people to `upsertEmbeddingStubs`; otherwise export a no-op. Wire by dependency injection so the core never dynamically imports an absent module. Log failures without failing sprint persistence.
  - Verify: adapter test/type-check in both enabled and no-op configuration; a write-through failure still advances a successfully persisted cell.

## Phase 4 — APIs

- [ ] **Add list, create, and preview routes**
  - Files: `src/routes/api/sprints/index.ts`, `src/routes/api/sprints/preview.ts`
  - Do: Require session. GET lists only caller rows. POST validates reviewed criteria/variants, enforces the active-sprint limit, and returns 201. Preview validates at most four variants, applies `rateLimit('sprint-preview', userId, 10, 60)`, runs deterministic `searchBuilders`, dedupes snapshots, and persists nothing.
  - Verify: authenticated curl covers manual no-AI preview and save; free save returns the standard upgrade response; malformed/foreign source returns 400.

- [ ] **Add sprint detail and lifecycle route**
  - Files: `src/routes/api/sprints/$sprintId.ts`
  - Do: GET/PATCH/DELETE with owner scope. PATCH accepts only `{ action: 'pause'|'resume' }`, `{ name }`, or `{ quota }`; resume rechecks plan limit. Return generic 404 for another user's ID and 409 for invalid transitions.
  - Verify: two-session curl proves isolation; pause stops worker eligibility, resume restores it, delete cascades results.

- [ ] **Add paginated results route**
  - Files: `src/routes/api/sprints/$sprintId/results.ts`
  - Do: Validate opaque cursor, `limit <= 100`, sort and `SprintFilter`; owner-check before results query; return `{ items, nextCursor, facets, total }` with viewer-specific tracked flags/row IDs.
  - Verify: pagination is stable across equal timestamps; another user receives 404; invalid cursor/filter receives 400.

- [ ] **Expose the admin worker endpoint**
  - Files: `src/routes/api/admin/sprints/run-worker.ts`
  - Do: Clone `src/routes/api/admin/alerts/run-worker.ts` auth/error shape, call `runSprintsWorker`, emit `sprint_worker_run`, and document the 30-minute VPS cron. Never accept a user/sprint ID in the body.
  - Verify: non-admin 403; admin gets `{ sprintsRun, resultsAdded, completed, failed }`; two immediate calls are safe.

## Phase 5 — UI

- [ ] **Create the sprint list route and navigation**
  - Files: `src/routes/_dashboard/sprints/index.tsx`, `src/modules/sprints/components/SprintsPage.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`
  - Do: Render name/status/count/quota/last run and pause/resume/delete actions; add authenticated Sprints nav. Preserve readable completed/paused dossiers after downgrade.
  - Verify: UI handles empty/loading/error and lifecycle actions; free user sees preview CTA plus Pro save copy.

- [ ] **Build the three-step browser-first wizard**
  - Files: `src/routes/_dashboard/sprints/new.tsx`, `src/modules/sprints/components/SprintWizard.tsx`, `src/modules/sprints/components/CriteriaEditor.tsx`, `src/modules/sprints/components/VariantEditor.tsx`
  - Do: Keep pasted text and `.txt` contents in component state only. Step 1 calls `ai('jd-parse')` with a curated ~4k-token local input and clearly labels server fallback for longer input; Step 2 calls `criteria-decompose`; both expose deterministic/manual editors. Step 3 calls preview and optionally saves reviewed structured data. Render `AIDownloadPrompt` when downloadable.
  - Verify: browser network/storage inspection proves local-success sends no raw text; Chrome unavailable uses MiniMax; AI-disabled completes manually; refresh clears raw text.

- [ ] **Build the dossier and refinement controls**
  - Files: `src/routes/_dashboard/sprints/$sprintId.tsx`, `src/modules/sprints/components/SprintDossier.tsx`, `src/modules/sprints/components/SprintRefinement.tsx`
  - Do: Render paginated `PersonResultCard`s, score/date sort, manual filters and honest raw-location facets. `filter-refine` changes only validated filter state. Tracking POSTs the full snapshot to `/api/builders/track` and updates returned `trackedRowId`; never uses `sprintResults.id` as a builder ID.
  - Verify: refine manually and via both AI tiers; track/untrack an existing and new result; Unknown facet works; no map appears.

## Phase 6 — Security, rollout, and runtime evidence

- [ ] **Run isolation, privacy, and abuse tests**
  - Files: `src/lib/sprints/service.test.ts`, `src/lib/sprints/worker.test.ts`, `src/shared/lib/sprints-shared.test.ts`
  - Do: Test cross-user read/mutate/delete, forged owner fields, malicious JD prompt text, invalid sources, oversized arrays/text, worker overlap, and plan downgrade. Assert raw JD/CV is absent from DB rows and logs.
  - Verify: `pnpm test sprints`.

- [ ] **Perform staged runtime verification**
  - Files: none
  - Do: On a migrated local/staging DB, complete manual, Chrome-local, and server-fallback flows; trigger the worker twice; inspect unique rows/cursor/quota; pause cron and verify no progression; set each task kill switch and verify manual usability.
  - Verify: capture curl/browser evidence, `pnpm test && pnpm type-check && pnpm lint && pnpm build` all pass.

## Future (not scheduled)

- Team sharing after both team dependencies, with server-resolved `organizationId` and cross-org isolation tests.
- PDF/DOCX extraction, normalized geocoding/MapLibre, and work-sample/code analysis as separate plans.
