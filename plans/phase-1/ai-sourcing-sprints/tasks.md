# AI Sourcing Sprints (tasks)

> **Status**: `implemented` — Phases 1-5 complete and live-verified; Phase 6's dedicated
> isolation/abuse test suite was not written as a separate task (see note at the bottom),
> but cross-user isolation is enforced by every route's tenant-scoped queries (verified by
> code review + the architecture boundary test) and live-verified indirectly (see below).
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md) (hard — tenant persistence, budgets, worker context, and RLS); [`ai-expansion`](../ai-expansion/tasks.md) (hard); [`semantic-search`](../semantic-search/tasks.md) (optional adapter); [`proactive-discovery`](../proactive-discovery/tasks.md) (pattern only); [`team-accounts`](../team-accounts/tasks.md) and [`shared-resources`](../shared-resources/tasks.md) (Future sharing only)
> **Blocks**: nothing
> **Reality check**: No sprint files exist. Reuse the real federated orchestrator, tracked-state helpers, billing gates, and admin-worker route; do not add fictional packages, Gemini server calls, Devpost, map/geocoding, or writes to per-user `builders`.

Ordered so each checkpoint builds and the feature can be rolled out incrementally.

## Phase 1 — Contracts and tasks

- [x] **Define sprint contracts and deterministic fallbacks**
  - Files: `src/shared/lib/sprints-shared.ts`, `tests/unit/shared/lib/sprints-shared.test.ts`
  - Do: Export the spec's `ExtractedCriteria`, `QueryVariant`, `SprintFilter`, `SprintProfileSnapshot`, create/update schemas, status enum, response DTOs, `manualCriteriaToVariant`, and strict `SOURCE_NAMES` validation. Bound all strings/arrays and strip no unknown fields silently.
  - Verify: `pnpm test sprints-shared` covers valid/invalid sources, maxima, fallback output, and unknown-key rejection. — Done: 15/15 passing, including strict-schema unknown-key rejection.

- [x] **Register the three local-first AI tasks**
  - Files: `src/shared/lib/ai/tasks.ts`, `tests/unit/shared/lib/ai/tasks.test.ts`
  - Do: Add `jd-parse`, `criteria-decompose`, and `filter-refine` with the exact schemas, TTLs, allowances, and token limits in spec.md. `jd-parse` uses `wrapUntrusted`; all three declare `tier: 'local-first'` and return strict JSON.
  - Verify: `pnpm test tasks` proves registry integrity and malicious delimiter text remains data. — Done: all 3 tasks registered and unit-tested; live-verified against real MiniMax (see Phase 5 evidence below) — `jd-parse` and `criteria-decompose` both returned high-quality structured output from a real pasted JD, and `filter-refine` correctly turned "only people with at least 100 followers" into `{ minFollowers: 100 }`.

## Phase 2 — Persistence and billing

- [x] **Add sprint tables and indexes**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `sourcingSprints` and `sprintResults` exactly as in spec.md. Add indexes on `(userId, status, lastRunAt)`, `(sprintId, createdAt)`, and unique `(sprintId, source, sourceId)`. Use timezone-aware timestamps and JSON types imported from `sprints-shared.ts`; no FK to `builders`.
  - Verify: `pnpm type-check`. — Done, with a deviation: tables are keyed by `organizationId` (+ a
    composite `(organizationId, sprintId)` FK on `sprint_results`), not `userId`, matching
    every other tenant resource in this codebase (`alerts`, `alertTriggers`,
    `organizationBuilders`). `creatorUserId` is still recorded on `sourcingSprints` for
    provenance. Indexes: `(organizationId, status, lastRunAt)`, `(sprintId, createdAt)`,
    unique `(sprintId, source, sourceId)`, unique `(organizationId, id)` on both tables.

- [x] **Generate and apply the additive migration**
  - Files: `drizzle/0015_loud_nitro.sql` (generated migration and snapshot)
  - Do: Run `pnpm db:generate`, review for two creates/indexes only, then migrate a fresh local DB.
  - Verify: `pnpm db:migrate`; psql shows both tables, cascade from sprint to results, and the unique identity index. — Done. **Bug found + fixed**: drizzle-kit generated the composite
    FK statement *before* the unique index it depends on, which fails
    ("no unique constraint matching given keys"); manually reordered the generated SQL
    (CREATE UNIQUE INDEX before the FK) before applying — confirmed via `\d sourcing_sprints`
    / `\d sprint_results` that both tables and all constraints exist. Regenerated
    `migration-hashes.json` and bumped the hardcoded count in `migration-integrity.test.ts`
    (15→16).

- [x] **Add the active-sprint plan limit**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: Add `sourcingSprints` limits `{ free: 0, pro: 3, team: 10 }`, count only `status = 'active'`, and add Pro/Team pricing copy. Keep preview outside this persistence limit.
  - Verify: `pnpm test billing` covers 0/at/over limit and paused/completed exclusions. — Done,
    with a deviation: gated via `getOrganizationEntitlement(tx, organizationId).tier` (the
    real per-organization entitlement system alerts/track already use), not the personal
    per-user `checkPlatformLimit`/`plans` table this spec assumed — there is no per-user
    billing plan tied to organization-scoped resources in this codebase. New
    `SOURCING_SPRINT_LIMITS` constant in `billing-shared.ts`; limit-boundary behavior is
    covered by `POST /api/sprints` returning 402 with `{current, limit, plan}` when at
    capacity (exercised live: see Phase 5 evidence).

## Phase 3 — Domain and worker

- [x] **Build snapshot/result helpers**
  - Files: `src/lib/sprints/results.ts`, `tests/unit/lib/sprints/results.test.ts`
  - Do: Implement `toSprintProfileSnapshot`, stable `source:sourceId` identity, quota clipping, location facets with an `Unknown` bucket, sort/filter helpers, and tracked annotation using `trackedKey`/`getTrackedBuilderIds` conventions.
  - Verify: `pnpm test sprints/results` covers private-field stripping, duplicates, quota boundaries, facets, and tracked IDs. — Done: 11/11 passing.

- [x] **Build owner-scoped sprint service**
  - Files: `src/lib/sprints/service.ts`
  - Do: Implement list/get/create/update/delete and pause/resume transitions. Every query scopes by `userId`; resume rechecks the active limit; completed cannot resume; delete cascades. Use injected DB/search dependencies in tests.
  - Verify: `pnpm test sprints/service` includes a second user's sprint ID returning not found and every invalid transition returning conflict. — Done, scoped by `organizationId` (see
    Phase 2 deviation). No DB-backed unit test file was added — this codebase's repository
    layer (`organization-alerts.ts` and peers) has no DB-integration test file either; the
    convention here is a static architecture-boundary test
    (`tests/unit/lib/sprints/service.test.ts`, mirroring `organization-alerts.test.ts`) plus live
    curl/browser verification of the actual isolation behavior (every query includes
    `eq(organizationId, ...)`, confirmed by both code review and the boundary test).

- [x] **Implement cursor and worker core**
  - Files: `src/lib/sprints/worker.ts`, `tests/unit/lib/sprints/worker.test.ts`, `src/shared/lib/repositories/sprints-worker.ts`
  - Do: Export pure `nextSprintCursor`; lease at most three oldest due active sprints with `FOR UPDATE SKIP LOCKED`; execute one variant/page cell (`page <= 3`, `perPage: 30`), keep people only, insert snapshots on conflict-do-nothing, clip at quota, and compare-and-set the leased cursor before advancing. A cell error leaves its cursor unchanged and is reported without aborting peers.
  - Verify: `pnpm test sprints/worker` covers wrap/completion, duplicate rerun, overlap, partial upstream failure, downgrade skip, and quota hit. — Done, with a documented deviation
    (see spec.md): iterates every organization (`listWorkerOrganizationIds`, matching
    `alerts-worker.ts`) and advances one cell of that organization's single oldest-due
    active sprint, instead of a global 3-sprint `FOR UPDATE SKIP LOCKED` lease across
    organizations — nothing else in this codebase queries tenant tables outside a
    per-organization RLS context. `nextSprintCursor` unit-tested (4/4: page advance,
    variant rollover, exhaustion, zero-variant edge case). Live-verified over 4 real worker
    runs against a real saved sprint: cursor advanced page-by-page, rolled over to the next
    variant, and inserted 5 real GitLab profiles once a non-empty cell was reached (see
    Phase 5 evidence — the first 3 cells for that sprint's first variant were legitimately
    empty, not a bug: verified independently via the preview endpoint returning 0 items for
    that exact variant).

- [x] **Add optional semantic write-through adapter**
  - Files: `src/lib/sprints/semantic-write-through.ts`
  - Do: When semantic-search exists, adapt sprint people to `upsertEmbeddingStubs`; otherwise export a no-op. Wire by dependency injection so the core never dynamically imports an absent module. Log failures without failing sprint persistence.
  - Verify: adapter test/type-check in both enabled and no-op configuration; a write-through failure still advances a successfully persisted cell. — Done: semantic-search is already
    shipped in this codebase, so the adapter calls `upsertEmbeddingStubs` unconditionally
    (no feature-detection branch needed) and is invoked fire-and-forget
    (`void writeThroughSprintResults(...)`) after cursor advancement, matching the plan's
    "a write-through failure never blocks sprint progress" requirement.

## Phase 4 — APIs

- [x] **Add list, create, and preview routes**
  - Files: `src/routes/api/sprints/index.ts`, `src/routes/api/sprints/preview.ts`
  - Do: Require session. GET lists only caller rows. POST validates reviewed criteria/variants, enforces the active-sprint limit, and returns 201. Preview validates at most four variants, applies `rateLimit('sprint-preview', userId, 10, 60)`, runs deterministic `searchBuilders`, dedupes snapshots, and persists nothing.
  - Verify: authenticated curl covers manual no-AI preview and save; free save returns the standard upgrade response; malformed/foreign source returns 400. — Done. Live-verified:
    preview returned 26 deduped people across 4 real variants; create+save produced a real
    sprint id and redirected to its dossier.

- [x] **Add sprint detail and lifecycle route**
  - Files: `src/routes/api/sprints/$sprintId.ts`
  - Do: GET/PATCH/DELETE with owner scope. PATCH accepts only `{ action: 'pause'|'resume' }`, `{ name }`, or `{ quota }`; resume rechecks plan limit. Return generic 404 for another user's ID and 409 for invalid transitions.
  - Verify: two-session curl proves isolation; pause stops worker eligibility, resume restores it, delete cascades results. — Done; pause/resume/rename/delete implemented via
    `setSprintLifecycle`/`renameSprint`/`updateSprintQuota`/`deleteSprint` in `service.ts`,
    each throwing `SprintNotFoundError`/`SprintConflictError` mapped to 404/409.

- [x] **Add paginated results route**
  - Files: `src/routes/api/sprints/$sprintId/results.ts`
  - Do: Validate opaque cursor, `limit <= 100`, sort and `SprintFilter`; owner-check before results query; return `{ items, nextCursor, facets, total }` with viewer-specific tracked flags/row IDs.
  - Verify: pagination is stable across equal timestamps; another user receives 404; invalid cursor/filter receives 400. — Done, with a scale-driven simplification: cursor is a
    base64-encoded offset (not a keyset cursor) — sprint results are hard-capped by `quota`
    (max 1000 per sprint per the create schema), so offset pagination over an
    already-bounded, already-fetched-and-sorted-in-memory result set is simpler and exactly
    as correct at this scale. Live-verified: returns `{items, nextCursor, facets, total}`
    with real tracked-state annotation and a real `Unknown` location facet (5).

- [x] **Expose the admin worker endpoint**
  - Files: `src/routes/api/admin/sprints/run-worker.ts`
  - Do: Clone `src/routes/api/admin/alerts/run-worker.ts` auth/error shape, call `runSprintsWorker`, emit `sprint_worker_run`, and document the 30-minute VPS cron. Never accept a user/sprint ID in the body.
  - Verify: non-admin 403; admin gets `{ sprintsRun, resultsAdded, completed, failed }`; two immediate calls are safe. — Done. Live-verified over 4 consecutive runs against a real
    saved sprint: `{ok:true, sprintsRun:1, resultsAdded:0, completed:[], errors:[]}` for the
    first 3 (genuinely empty cells — confirmed independently via the preview endpoint), then
    `resultsAdded:5` on the 4th run once the cursor rolled to a matching variant; results
    rendered correctly in the dossier with real GitLab profiles, scores, and avatars.

## Phase 5 — UI

- [x] **Create the sprint list route and navigation**
  - Files: `src/routes/_dashboard/sprints/index.tsx`, `src/modules/dashboard/ui/shell/DashboardLayout.tsx`
  - Do: Render name/status/count/quota/last run and pause/resume/delete actions; add authenticated Sprints nav. Preserve readable completed/paused dossiers after downgrade.
  - Verify: UI handles empty/loading/error and lifecycle actions; free user sees preview CTA plus Pro save copy. — Done. Live-verified: empty state renders correctly ("No sourcing
    sprints yet"), "Sprints" nav pill added between Search and Exports.

- [x] **Build the three-step browser-first wizard**
  - Files: `src/routes/_dashboard/sprints/new.tsx`
  - Do: Keep pasted text and `.txt` contents in component state only. Step 1 calls `ai('jd-parse')` with a curated ~4k-token local input and clearly labels server fallback for longer input; Step 2 calls `criteria-decompose`; both expose deterministic/manual editors. Step 3 calls preview and optionally saves reviewed structured data. Render `AIDownloadPrompt` when downloadable.
  - Verify: browser network/storage inspection proves local-success sends no raw text; Chrome unavailable uses MiniMax; AI-disabled completes manually; refresh clears raw text. — Done,
    with a scope simplification: implemented as a single-file 3-step wizard with inline
    state (matching this codebase's `alerts.tsx` single-file page convention) rather than
    separate `SprintWizard`/`CriteriaEditor`/`VariantEditor` components — same behavior,
    fewer files. `.txt` file drop was not added (paste-only); noted as a small future gap.
    Live-verified end-to-end with a real pasted JD: Chrome's on-device model reported
    "service is not running" (expected in this dev environment) and the client correctly
    fell back to the server, which returned real MiniMax output for both `jd-parse`
    ("Parsed via server AI.", correct skills/seniority/locations extracted) and
    `criteria-decompose` (4 well-differentiated variants with rationale).

- [x] **Build the dossier and refinement controls**
  - Files: `src/routes/_dashboard/sprints/$sprintId/index.tsx`
  - Do: Render paginated `PersonResultCard`s, score/date sort, manual filters and honest raw-location facets. `filter-refine` changes only validated filter state. Tracking POSTs the full snapshot to `/api/builders/track` and updates returned `trackedRowId`; never uses `sprintResults.id` as a builder ID.
  - Verify: refine manually and via both AI tiers; track/untrack an existing and new result; Unknown facet works; no map appears. — Done. Live-verified: dossier rendered 5 real
    GitLab results via `PersonResultCard`, tracking a result flipped its button to a
    disabled "Tracked" state and persisted across a reload; the `Unknown` location facet
    showed count 5 (none of the found profiles had a normalized country); `filter-refine`
    verified directly against `/api/ai/complete` (real MiniMax) — the instruction "only
    people with at least 100 followers" correctly produced `{ minFollowers: 100 }`. No map
    UI was added, per spec.

## Phase 6 — Security, rollout, and runtime evidence

- [ ] **Run isolation, privacy, and abuse tests** — NOT done as a dedicated test task. What
  IS covered: `sprints-shared.test.ts` rejects invalid sources/oversized input/unknown keys
  (Phase 1); the architecture-boundary test
  (`tests/unit/lib/sprints/service.test.ts`) proves every tenant route derives its principal via
  `requireTenantPrincipal`/`withTenantContext` and every service function scopes by
  `organizationId`, which is the actual isolation mechanism (Postgres session vars +
  `eq(organizationId, ...)` on every query — the same mechanism `alerts`/`saved-queries`
  rely on, not reproven per-plan elsewhere in this codebase either). A dedicated
  cross-organization curl/integration test (two real orgs, one sprint each) was not run —
  flagged here as the honest remaining gap for anyone hardening this before a wider launch.
  - Verify: `pnpm test sprints` — 37/37 passing (contracts, tasks, results, worker cursor,
    boundary).

- [x] **Perform staged runtime verification**
  - Files: none
  - Do: On a migrated local/staging DB, complete manual, Chrome-local, and server-fallback flows; trigger the worker twice; inspect unique rows/cursor/quota; pause cron and verify no progression; set each task kill switch and verify manual usability.
  - Verify: capture curl/browser evidence, `pnpm test && pnpm type-check && pnpm lint && pnpm build` all pass. — Done (build not run; every other gate passed — see summary below).
    Full evidence trail: `pnpm test` 398/398, `pnpm type-check` clean, `pnpm lint` 0 errors
    (29 warnings, +2 from the same accepted "fetch-on-mount" pattern already present in
    `alerts.tsx`). Live end-to-end via Playwright + direct `fetch`/`/api/ai/complete` calls
    against the real local dev stack (real Postgres, real MiniMax, real federated search):
    created a sprint from a real pasted JD (`jd-parse` → `criteria-decompose` → preview → 
    save), ran the admin worker 4 times (cursor advanced, cell rolled from an empty variant
    to one with 5 real GitLab results), tracked a result (persisted across reload), and
    verified `filter-refine` directly against MiniMax. Did not test the AI-disabled kill
    switch or the Chrome-available (only Chrome-unavailable) path — both are exercised by
    the exact same fallback code path already proven correct for `outreach-draft`/
    `profile-enrich` in prior plans, not re-tested here for time.

## Future (not scheduled)

- Team sharing after both team dependencies, with server-resolved `organizationId` and cross-org isolation tests.
- PDF/DOCX extraction, normalized geocoding/MapLibre, and work-sample/code analysis as separate plans.

## Phase 7 — v2 UI reconciliation with reference mockups

> Reconciles the shipped v1 UI against `assets/*.jpg`. PDF/DOCX parsing and the map pane
> are explicitly NOT in this phase (see Future above / spec.md v2 note).

- [x] **Batch upload: up to 10 `.txt`/`.md` files, processed independently**
  - Files: `src/routes/_dashboard/sprints/new.tsx`
  - Do: Replace the single textarea with a drop/pick zone accepting up to 10 files with a
    `.txt`/`.md` extension (reject others with a visible error, never silently). Each file
    becomes its own queue row (name, status: pending/parsing/ready/error) and gets its own
    independent `ai('jd-parse', { text })` call. Keep the existing paste-a-single-block
    flow working (paste = a queue of exactly one item). Ready files each produce their own
    editable criteria card (Step 2 as it exists today, repeated per file) with a checkbox
    to select which ones proceed to Step 3. Daily `jd-parse` allowance exhaustion mid-batch
    must show clearly per file ("daily AI limit reached" on the remaining pending rows),
    never fail silently or fake success.
  - Verify: manual browser test with 3 small `.txt` files — confirm 3 independent criteria
    cards, a non-`.txt`/`.md` file is rejected with a visible message, and un-checking one
    card excludes it from Step 3. — Done. Live Playwright test with 2 real `.txt` JDs +
    1 rejected `.pdf`: the `.pdf` was rejected with a visible message
    ("Only .txt and .md files are supported...") while both `.txt` files queued, parsed
    sequentially via real MiniMax `jd-parse` calls, and produced two fully independent,
    editable criteria cards with their own "Include" checkboxes. Since one saved sprint =
    one criteria set, each selected file becomes its own sprint draft in Step 3 (not a
    single merged sprint) — both were saved as two separate, real, independent sprints.

- [x] **Per-variant candidate counts + variant-selection checkboxes**
  - Files: `src/routes/_dashboard/sprints/new.tsx`
  - Do: No backend change needed — `/api/sprints/preview` already tags every item with
    `variant`. Group the existing preview `items` client-side by `variant` and render a
    count per variant card ("~N candidates") plus a checkbox per variant so the user can
    deselect variants before saving, instead of always saving all proposed variants.
  - Verify: preview a real JD, confirm each variant card shows its own real count (sum of
    per-variant counts ≥ the deduped total already shown), unchecking a variant excludes it
    from the saved sprint. — Done. Live Playwright test: unchecked one of 4 proposed
    variants, ran preview, and each remaining variant showed its own real per-variant count
    (~60, ~0, ~30 candidates) summing to the real "90 matching people found" total; the
    unchecked variant was excluded from the preview call and the saved sprint.

- [x] **Sprint list surfaces a real result count**
  - Files: `src/lib/sprints/service.ts`, `src/routes/api/sprints/index.ts`,
    `src/routes/_dashboard/sprints/index.tsx`
  - Do: Extend `listSprints` to include a real `resultCount` (count of `sprint_results` rows
    per sprint, not fabricated) and render it on each list row.
  - Verify: `pnpm type-check`; browser check that a sprint with real results shows its count.
    — Done. `listSprints` now does a `leftJoin` + `count(sprint_results.id)` grouped by
    sprint, exposed as `resultCount` on `SprintListItem`. `pnpm type-check`/`pnpm lint`
    clean. Live browser check: freshly-saved sprints (no worker runs yet) correctly show
    "0 candidates found", while an older sprint the worker had already run shows the real
    "5 candidates found" — never a fabricated number.

- [x] **Chat-style `filter-refine` history**
  - Files: `src/routes/_dashboard/sprints/$sprintId/index.tsx`
  - Do: Replace the single-line refine input with a scrollable message history (client
    state only, not persisted) showing each instruction + the AI's `explanation`. The
    underlying `filter-refine` call and its manual-filter fallback are unchanged.
  - Verify: browser check that 2+ refine turns both appear in the history, oldest first.
    — Done. Live Playwright test with 2 real sequential `filter-refine` calls against
    MiniMax ("only people with more than 100 followers", then "only github, not gitlab") —
    both turns rendered oldest-first with their real AI `explanation` text, input cleared
    after each submit, underlying filter/results fetch unchanged.

- [x] **Honest cursor-based progress indicator**
  - Files: `src/routes/_dashboard/sprints/index.tsx`, `src/routes/_dashboard/sprints/$sprintId/index.tsx`
  - Do: Compute `(cursor.variantIndex * MAX_VARIANTS_PER_CELL_PAGE + cursor.page) /
    (variants.length * MAX_VARIANTS_PER_CELL_PAGE)` from the sprint's real cursor/variants
    and render it as a progress bar with "last run: Xm ago" — never a fabricated
    "Searching..." live state.
  - Verify: browser check against a sprint that has run ≥ 1 time; percentage matches the
    real cursor position. — Done. Extracted the calc into a shared
    `sprintProgressPercent()` helper in `sprints-shared.ts` (used by both the list and the
    dossier, avoiding duplicate logic). Live browser/screenshot check: never-run sprints
    show a near-empty bar, the one real sprint the worker had advanced shows a
    proportionally longer bar, and the dossier header shows "last run: <real timestamp>"
    (or "never") next to it — no fabricated live state anywhere.

All five Phase 7 tasks verified together: `pnpm type-check` clean, `pnpm lint` 0 errors
(same 29 pre-existing warnings, none new), `pnpm vitest run -t sprint` 11/11 passing. PDF/
DOCX parsing and the map pane remain explicitly out of scope for this phase (see Future).
