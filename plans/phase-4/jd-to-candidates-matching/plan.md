# Paste-a-JD Candidate Matching (plan)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../phase-1/22-semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW query path — already shipped); [`ai-expansion`](../../phase-1/21-ai-expansion/spec.md) (task registry, budgets, zod validation, kill switches — already shipped); [`stripe-billing-platform`](../../phase-1/30-stripe-billing-platform/spec.md) (the Pro Max tier this feature is gated on does not bill anyone yet). Enhanced by [`match-evidence-panel`](../match-evidence-panel/spec.md) and [`availability-signals`](../availability-signals/spec.md) — dashed, never blocking; see spec.md "Optional enhancers" for exactly what is borrowed and what happens without it.
> **Blocks**: nothing
> **Reality check (re-verified at HEAD 2026-07-27)**: Builds on `src/lib/semantic/semantic-search.ts` (`SEMANTIC_MIN_LOCAL_MATCHES`, `SEMANTIC_SIMILARITY_THRESHOLD`), `src/shared/lib/repositories/public-builder-embeddings.ts` (whose HNSW ordering fix has **already landed** — this plan asserts, never re-applies), `src/lib/semantic/index-writer.ts`, `src/shared/lib/ai/{tasks,cache,budget,embeddings,minimax}.ts`, `src/shared/lib/billing/{rate-cards,feature-authorization}.ts`, `src/shared/lib/repositories/alerts-worker.ts` (the worker-role batching shape), `src/routes/api/admin/legal/run-worker.ts`, `src/modules/dashboard/ui/shell/nav-config.ts`. One new tenant-private table (`jd_match_runs`, unclaimed), two new AI tasks (`match-jd-requirements`/`match-jd-rerank`, both unclaimed), one new rate card (`jd_match`, unclaimed), one new `PermissionAction` (`match:delete`, unclaimed), zero new env vars, zero new workers.

## Phases (dependency order — shippable after each)

### Phase 1 — Schema, RLS, classification (dead table)

Add `jdMatchRuns` to `src/shared/lib/db/schema.ts` exactly as spec §5 (composite tenant unique,
composite tenant FK to `billing_credit_reservations`, `mode` check constraint, `artifact_version`,
`expires_at` index). Mint the schema migration with `pnpm db:generate`, then mint a **second,
separate** migration for RLS + per-role grants with `pnpm exec drizzle-kit generate --custom`
(never a hand-created `.sql` — `pnpm test:migration-integrity` requires a journal entry *and* a
snapshot, which only the generator writes), modelled on
`drizzle/0044_abuse_usage_integrity_rls_grants.sql`. Read the real next index from
`drizzle/meta/_journal.json` at the moment you run it; never hardcode a number. Register the
table in `scripts/db/audit-schema.ts` (a table in `schema.ts` that is absent there makes
`pnpm db:audit-schema` report `unclassified table` and exit 1),
`docs/architecture/data-classification.md`, and `docs/architecture/authorization-matrix.md`. No
behaviour change; the table has no readers.

### Phase 2 — Pure libraries + tests (no AI, no DB, no network)

Four pure modules, each with a test under `tests/unit/**` (the repo has **zero** co-located tests;
`vitest.config.ts` includes only `tests/unit/**/*.{test,spec}.{ts,tsx}`, mirroring `src`):
`src/shared/lib/match-shared.ts` (the zod schemas `tasks.ts` will import — must stay
client-safe, so no `node:crypto` here), `src/lib/match/rrf.ts` (`fuseByReciprocalRank`,
`RRF_K = 60`), `src/lib/match/citations.ts` (normalization, exact-substring then 90 %
token-containment verification, evidence/candidate drop + backfill rules), and
`src/lib/match/jd-requirements.ts` (JD normalization, `jdFingerprintOf`, length guards,
paragraph-boundary truncation, probe assembly capped at 6). This phase is where the design is
actually proven; everything after it is plumbing.

### Phase 3 — AI tasks + retrieval extension

Register `match-jd-requirements` and `match-jd-rerank` in `src/shared/lib/ai/tasks.ts` with the
schemas from Phase 2, the `<untrusted>` prompt construction, allowances
`{ free: 0, pro: 0, team: 30 }`, and `maxOutputTokens` 900 / 3000. The shared HNSW ordering fix
this phase used to own has **already landed** — `similarBuilderEmbeddingsQuery` orders by
`asc(cosineDistance(...))` with `similarity` as a select column, covered by an EXPLAIN regression
test with a negative control — so the only work here is to **assert** that shape and reuse it. Add
`findSimilarBuilderEmbeddingsForMatch` (multi-vector, returns `document`) on the same ordering, and
`findRestrictedIdentityPairs(pairs)` built on the `SECURITY DEFINER`
`is_builder_processing_restricted(text)` function — **not** a join against
`builder_processing_restrictions`, which `builderhunt_app` has no grant for. Add the tenant-scoped
cache get/set pair to `src/shared/lib/ai/cache.ts`. Add the `jd_match` rate card. Still no
user-visible surface.

### Phase 4 — Match service (the two-stage orchestration)

`src/lib/match/match-service.ts#runJdMatch()`: extraction (tenant-scoped cache via
`tenantAiCacheKey`) → `embedTexts(probes)` → K HNSW queries → restriction filter → hard filters
→ RRF → pool cap 50 → cold-index ladder reusing `SEMANTIC_MIN_LOCAL_MATCHES` and
`searchBuilders` + `upsertEmbeddingStubs` → single batched rerank → citation verification →
backfill → `mode` decision. Every failure path resolves to a mode, never to an exception
escaping to the caller. Each of the three provider call sites (`minimaxChat` ×2, `embedTexts` ×1)
sits in a top-level function that also calls `checkAndConsumeBudget`, or
`pnpm security:provider-metering` fails the build. `runJdMatch` takes an optional `deps` bag
defaulting to the real implementations, so the ladder is unit-testable without a network — the
same injection shape `repositories/abuse-signals.ts` and `shared/lib/profile-removal.ts` already
use. Repository `src/shared/lib/repositories/jd-match-runs.ts` (tenant-scoped,
`withTenantContext` only, never the global `db`), plus
`src/shared/lib/repositories/jd-match-runs-worker.ts` for the retention sweep, which runs under
`builderhunt_worker` and therefore takes a `WorkerTransaction` (same split as
`alerts.ts` / `alerts-worker.ts`).

### Phase 5 — API routes, billing gate, isolation proof

`POST /api/match/run` (auth → `paidActionsAllowed` → `checkEntitlement('jd_match')` →
`reserveCredits` → run → persist → `settleReservation` 10/3 or `releaseReservation` 0),
`GET /api/match/runs`, `GET|DELETE /api/match/$runId`. Extend
`scripts/db/verify-api-isolation-local.mjs` with a `checkJdMatchRuns()` proving A/B isolation,
spoofed-organization rejection, and 404-not-403 on a foreign run id. The feature is now
complete and correct but reachable only by an organization with a real paid subscription — i.e.
nobody, today. That is the intended dark-ship state.

### Phase 6 — `/match` UI

`src/routes/_dashboard/match/{index,$runId}.tsx` + `src/modules/match/components/`
(`MatchPage`, `MatchRunView`, `MatchCandidateCard`): textarea composer with the
external-AI-processing notice and the "save this job description" opt-in, run history list,
ranked list with fit score / verdict / matched-and-missing requirement chips / quoted evidence
with source links, and honest mode banners for `hybrid` / `deterministic` / truncated. Locked
Pro Max state for unentitled orgs; whole surface hidden when `useAICapabilities` reports AI
disabled. Nav entry in `nav-config.ts`'s `discover` area (`items` **and** `routes`) + the one-line
`/search` `NoResults` cross-link.

### Phase 7 — Retention, disclosure, observability

Add a `builderhunt_worker`-role purge of `jd_match_runs` past `expires_at`, called from the
existing legal worker alongside `processPendingDeletions()` — per organization, each in its own
`withWorkerOrganization` transaction. Add the retention clause to the privacy page's existing
MiniMax subprocessor entry (which already discloses that job-description text is sent). Add
structured counters for `droppedEvidence`, unknown-candidate rate, mode distribution and per-run
token totals (redacted correlation only, never prompt text). Full
`pnpm ci:local` pass.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Rerank quality is no better than RRF order, so 10 credits buys nothing | Medium | High | Phase 2 lands RRF first and the `deterministic` mode already ships a usable list; hold a 20-JD hand-labelled comparison before enabling the rate card, and keep the pool ordering visible (`rrfScore` persisted) so the two are always comparable |
| Model fabricates evidence citations | High | High | Verification gate is structural, not prompt-based (spec §4): unverifiable items dropped, evidence-less candidates dropped and backfilled, `droppedEvidence` persisted and alerted above 10 % |
| Prompt injection inside a pasted JD or a bio | Medium | Medium | `wrapUntrusted` on both, per-candidate blocks with the id outside the block, post-parse whitelists for `candidateId`/`requirementId`, fixed output schema, > 20 % unknown ids treated as a parse failure |
| Rerank token cost drifts up as documents grow | Medium | Medium | 600-char per-candidate trim, pool hard cap 50, one batched call only, `maxOutputTokens` 3000, rate limit 5/5 min, daily allowance 30 |
| A 5 000-word JD blows `maxOutputTokens` or the 30 s MiniMax timeout | Medium | Medium | 32 000-char input cap with visible truncation; extraction and rerank are separate calls so neither carries the other's payload; `AIProviderError` → release + honest error |
| Nobody can use the feature because `STRIPE_BILLING_ENABLED=false` | Certain (today) | Low | Intended: dark ship. Locked UI state, no reservation, no provider call. Local/E2E use a seeded `livemode: false` subscription row + credit grant — data, not a code bypass |
| Confidential JD text leaks into logs, URLs or localStorage | Medium | High | Dedicated route (never `?q=`), no localStorage recents, `jdText` NULL by default, fingerprint-only idempotency, log allowlist of task/provider/latency/tokens/status |
| New table queried for the first time as the real non-owner role hits a missing grant | High | Medium | `app-reality.md` constraint 7 — the RLS+grants migration and the `verify-api-isolation-local.mjs` extension are both explicit tasks, not afterthoughts |
| A restricted subject appears in an old saved run | Low | High | Display profiles are re-read from `builder_embeddings` at view time and re-filtered against active restrictions, so the exclusion is retroactive |
| **The subject-rights filter reads a table `builderhunt_app` cannot see** | **Was certain as originally designed** | High | **Redesigned 2026-07-27.** The original stage-1 step 3 joined `builder_identities` → `builder_processing_restrictions`; `drizzle/0017_enrichment_rls_policies.sql:57-62` revokes that table from `PUBLIC` and grants it only to `builderhunt_platform`, and its own comment forbids app/worker reads outright. The service would have thrown `permission denied` the first time it ran as the real runtime role, in production, after the credits were already reserved. `findRestrictedIdentityPairs` now goes through the `SECURITY DEFINER` `is_builder_processing_restricted(text)` (0017:70) that already holds `GRANT EXECUTE … TO builderhunt_app` (0017:82) — the same call `repositories/enrichment.ts:187` makes |
| **The retention purge silently deletes nothing** | **Was certain as originally designed** | Medium | **Redesigned 2026-07-27.** Phase 7 said "per organization inside its own tenant transaction" against a repository typed `TenantTransaction` (the `builderhunt_app` role), whose RLS only ever sees `app.organization_id` — a cross-org sweep from the legal worker would have been an RLS-silent no-op, the exact defect class app-reality constraint 7 catalogues. The purge now runs as `builderhunt_worker` via `listWorkerOrganizationIds()` + `withWorkerOrganization()` (`repositories/alerts-worker.ts`), and lives in `jd-match-runs-worker.ts` typed `WorkerTransaction` |
| A provider call lands in a function with no metering gate in scope | Medium | Medium | `pnpm security:provider-metering` is a hard CI step and matches `checkAndConsumeBudget`/`reserveCredits` by brace-depth within the *same* top-level function; all three call sites are placed accordingly, and the script is a named `Verify:` on the service task |
| Stage 1 is slower than budgeted because retrieval does not use the HNSW index | **Resolved** | High | The ordering fix shipped and is asserted at HEAD: `similarBuilderEmbeddingsQuery` uses `asc(cosineDistance(...))` with `similarity` as a select column, EXPLAIN-tested under `enable_seqscan = off` with a negative control. This plan reuses it and adds `findSimilarBuilderEmbeddingsForMatch` on the same shape. Residual risk is a *revert*: if that `orderBy` returns to a derived descending expression, this plan's 300 ms stage-1 budget is void |
| The EXPLAIN acceptance check fails on a *correct* query | Medium | Low | An indexable `ORDER BY` makes the index available, not mandatory; below ~2k embedded rows the planner legitimately prefers a seq scan (measured at `LIMIT 50`: 352 rows → seq scan ~7 ms; 2k/5k/20k → HNSW). Every EXPLAIN assertion runs under `set local enable_seqscan = off`, mirroring the existing test |

## Rollback

- **Phases 1–3** are invisible: drop `jd_match_runs` (single additive table, nothing else
  references it), remove the two task registry entries and the `jd_match` rate card. No shipped
  behaviour touched — the extension to `public-builder-embeddings.ts` is additive,
  `findSimilarBuilderEmbeddings`/`similarBuilderEmbeddingsQuery` are read-only reuse, and the
  cache helpers are new exports beside the existing ones. Reverting also means removing the
  `jd_match_runs` entry from `scripts/db/audit-schema.ts`, or `pnpm db:audit-schema` reports
  `classification has no schema table`.
- **Phases 4–5**: delete the three API routes. Or leave the code and gate it off without a
  deploy: `AI_DISABLED_TASKS=match-jd-requirements,match-jd-rerank` (503 + hidden UI), or set
  both tasks' `allowances.team` to `0`, or retire the `jd_match` rate card (unknown feature →
  `checkEntitlement` returns `unknown_feature` → 403). Three independent kill switches, none of
  which affect search, semantic search, sprints, or billing.
- **Phase 6**: remove the nav pill and the two route files; the `/search` cross-link is one line.
- **Phase 7**: retention is additive to an existing worker; removing the purge branch leaves rows
  in place and harms nothing except storage.
- Data: `jd_match_runs` holds only derived artifacts plus opt-in JD text, so dropping the table
  destroys no source-of-truth data. Credits already settled are not reversed by a rollback —
  `refundUsage` in `feature-authorization.ts` is the sanctioned path if that is ever required.
