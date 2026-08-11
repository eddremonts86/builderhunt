# AI Sourcing Sprints (plan)

> **Status**: `implemented` — Phases 1-5 shipped, tested (`pnpm test` 398/398, `pnpm lint`
> 0 errors), and live-verified end-to-end against real MiniMax + the federated search
> connectors (see tasks.md for evidence and documented deviations from this doc's original
> per-user/global-worker design).
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/plan.md) (hard — tenant persistence, budgets, worker context, and RLS); [`ai-expansion`](../21-ai-expansion/spec.md) (hard); [`semantic-search`](../22-semantic-search/spec.md) (optional index write-through); [`proactive-discovery`](../23-proactive-discovery/spec.md) (pattern only); [`team-accounts`](../27-team-accounts/spec.md) and [`shared-resources`](../28-shared-resources/spec.md) (Future sharing only)
> **Blocks**: nothing
> **Reality check**: No sprint schema, worker, API, or UI exists. This plan reuses `src/lib/search.ts`, `src/routes/api/search/builders.ts`, `src/routes/api/builders/track.ts`, `src/shared/lib/tracked-builders.ts`, `src/shared/lib/billing.ts`, and the admin worker pattern in `src/routes/api/admin/alerts/run-worker.ts`; it does not add connectors, a queue, a map, or a second AI client.

## Delivery strategy

Ship an immediately useful deterministic search workspace first, then persistence and cron continuation. The only AI work is the three interactive `local-first` tasks in the shared registry. No LLM executes in the worker.

## Phase 1 — Shared contracts and AI tasks

Create `src/shared/lib/sprints-shared.ts` with the zod contracts from the spec: criteria,
query variants, filters, profile snapshots, create/update bodies, and response DTOs. Register
`jd-parse`, `criteria-decompose`, and `filter-refine` in
`src/shared/lib/ai/tasks.ts`. Keep task prompts pure, delimit the pasted JD/CV as untrusted,
and retain deterministic manual fallbacks in the feature module rather than the platform.

Checkpoint: the task registry and all shared contracts are testable with no DB or UI change.

## Phase 2 — Additive schema and billing

Add `sourcing_sprints` and `sprint_results` exactly as specified, including ownership,
status/cursor indexes, and unique `(sprint_id, source, source_id)`. Generate and review an
additive Drizzle migration. Add `sourcingSprints` to every `PLAN_LIMITS` tier and its limit
key tests; add the Pro/Team pricing copy only when the save API is ready.

Checkpoint: migration is safe and dormant; existing users and `builders` rows are untouched.

## Phase 3 — Domain service and worker

Implement `src/lib/sprints/results.ts` for public snapshot conversion, stable identity,
dedupe, quota clipping, location facets, and tracked-state annotation. Implement
`src/lib/sprints/service.ts` for owner-scoped list/get/create/update/delete and state
transitions. All mutations fetch by `(id, userId)`; unsupported transitions return 409.

Implement `src/lib/sprints/worker.ts` with a pure cursor transition helper and a DB-backed
runner. It leases at most three due active sprints with a short `FOR UPDATE SKIP LOCKED`
transaction, executes one search cell per sprint outside the transaction, then conditionally
updates the unchanged cursor. Unique result keys and compare-and-set cursor updates make
overlapping cron calls safe. A failed cell records an error in the report, advances no cursor,
and does not fail other sprints. Semantic indexing is an explicit deployment adapter:
`src/lib/sprints/semantic-write-through.ts` exists only when semantic-search is installed;
the sprint core accepts a no-op callback and never imports a missing optional module.

Checkpoint: a seeded sprint progresses to completion under repeated and concurrent runs.

## Phase 4 — API surface

Add authenticated routes:

- `GET/POST /api/sprints` — list owner rows; create a saved sprint after re-validating all
  client-produced criteria/variants and enforcing the active-sprint limit.
- `GET/PATCH/DELETE /api/sprints/$sprintId` — owner-scoped detail and lifecycle mutations;
  PATCH accepts `{ action: 'pause' | 'resume' }` or editable `{ name, quota }`.
- `POST /api/sprints/preview` — free-tier-compatible immediate deterministic run from
  validated variants, maximum four variants and 30 results per variant; no persistence.
- `GET /api/sprints/$sprintId/results` — paginated results (`cursor`, `limit <= 100`), sort
  and filter validation, location facets, tracked annotation.
- `POST /api/admin/sprints/run-worker` — admin-only, idempotent worker entry point; returns
  `{ sprintsRun, resultsAdded, completed, failed }`.

Every route uses session auth, zod, `rateLimit`, generic 404s for foreign IDs, and bounded
payloads. Preview has a 10/minute per-user limit; writes have 30/minute. The worker is called
by VPS cron every 30 minutes.

Checkpoint: curl covers create → preview/save → worker → dossier → pause/resume/delete and
cross-user isolation.

## Phase 5 — Workspace UI

Add route files under `src/routes/_dashboard/sprints/` and feature components under
`src/modules/sprints/components/`. The new-sprint wizard keeps pasted text in browser memory;
only reviewed structured criteria and accepted variants are sent on save. A `.txt` drop is
read client-side and never uploaded as a file. Chrome AI is attempted first via `ai()` and
`AIDownloadPrompt`; MiniMax fallback parity is automatic. Manual criteria and variant editors
remain available when both tiers fail.

The dossier reuses `PersonResultCard` for display but owns a small action wrapper that sends
the complete snapshot to `/api/builders/track`; it does not assume a sprint result ID is a
tracked-builder ID. Filter refinement only changes visible filter state. Add a Sprints nav
entry for authenticated users; saving shows the Pro upgrade response when gated.

Checkpoint: the full no-AI manual flow and Chrome/MiniMax flows reach the same persisted
sprint contract.

## Phase 6 — Operations and rollout

1. Deploy migration and task registry with routes/UI hidden behind `AI_DISABLED_TASKS` or no
   nav entry.
2. Enable preview for internal/admin accounts; validate source load and MiniMax budgets.
3. Enable Pro saves, then activate the cron at 30-minute cadence.
4. Watch structured `sprint_worker_run` metrics: due, run, added, failed, duration, and
   per-source failures. Pause cron first if upstream pressure rises.
5. Enable Team limits. Shared sprint visibility remains out of scope until both team plans
   are implemented; there is no dormant `organizationId` column in v1.

## Risks

| Risk                                           | Likelihood | Impact | Mitigation                                                                                            |
| ---------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Overlapping cron runs duplicate work           | Medium     | Medium | `SKIP LOCKED`, compare-and-set cursor, unique result identity, idempotency tests                      |
| A crafted AI result reaches search/source code | Medium     | High   | Re-validate criteria and variants at every API boundary; source enum and strict maxima                |
| Pasted CV/JD leaks unexpectedly                | Low        | High   | Browser-memory-only input; local-first default; explicit server-fallback copy; never persist raw text |
| Active sprint load exceeds source limits       | Medium     | Medium | Three sprints/run, one cell/sprint, page cap, 30-minute cron, pause control and metrics               |
| Optional semantic dependency breaks deploy     | Low        | Medium | Dependency injection/no-op adapter; no runtime import unless semantic-search is installed             |
| Team promise precedes team isolation           | Low        | High   | No sharing fields or UI until `team-accounts` + `shared-resources` land                               |

## Rollback

Remove the cron first, hide Sprints navigation, and set the three task IDs in
`AI_DISABLED_TASKS`. Existing dossiers remain readable while writes are disabled. The schema
is additive; retain tables during code rollback and drop them only in a later reviewed
migration. Keyword search, tracking, and `builders` are unaffected.

## Future

After both team dependencies ship, add `organizationId`/visibility with server-resolved org
scope and explicit cross-org isolation tests. PDF/DOCX parsing, normalized geocoding/maps,
and 38-work-sample/code analysis remain separate future work.
