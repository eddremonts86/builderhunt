# Paste-a-JD Candidate Matching (plan)

> **Status**: `pending`
> **Depends on**: [`semantic-search`](../../semantic-search/spec.md) (global `builder_embeddings` + pgvector HNSW query path — already shipped); [`ai-expansion`](../../ai-expansion/spec.md) (task registry, budgets, zod validation, kill switches — already shipped); [`stripe-billing-platform`](../../stripe-billing-platform/spec.md) (the Pro Max tier this feature is gated on does not bill anyone yet). Enhanced by [`match-evidence-panel`](../match-evidence-panel/spec.md) (per-match evidence rendering) and [`availability-signals`](../availability-signals/spec.md) (ranking boost; neither is required).
> **Blocks**: nothing
> **Reality check**: Builds on `src/lib/semantic/semantic-search.ts` (`SEMANTIC_MIN_LOCAL_MATCHES`, `SEMANTIC_SIMILARITY_THRESHOLD`), `src/shared/lib/repositories/public-builder-embeddings.ts`, `src/lib/semantic/index-writer.ts`, `src/shared/lib/ai/{tasks,cache,budget,embeddings,minimax}.ts`, `src/shared/lib/billing/{rate-cards,feature-authorization}.ts`, `src/routes/api/admin/legal/run-worker.ts`. One new tenant-private table, two new AI tasks, zero new env vars, zero new workers.

## Phases (dependency order — shippable after each)

### Phase 1 — Schema, RLS, classification (dead table)

Add `jdMatchRuns` to `src/shared/lib/db/schema.ts` exactly as spec §5 (composite tenant unique,
composite tenant FK to `billing_credit_reservations`, `mode` check constraint, `expires_at`
index). Generate the migration with `pnpm db:generate`, then hand-append a second migration for
RLS + per-role grants modelled on `drizzle/0044_abuse_usage_integrity_rls_grants.sql` —
drizzle-kit emits neither. Register the table in `docs/architecture/data-classification.md` and
`docs/architecture/authorization-matrix.md`. No behaviour change; the table has no readers.

### Phase 2 — Pure libraries + tests (no AI, no DB, no network)

Three pure modules with sibling `*.test.ts`, all independently verifiable:
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
`{ free: 0, pro: 0, team: 30 }`, and `maxOutputTokens` 900 / 3000. **First correct the shared
ordering defect**: `findSimilarBuilderEmbeddings` sorts by the derived
`1 - (embedding <=> $vec)` DESC, which pgvector's HNSW index cannot serve (measured:
`Limit → Sort → Seq Scan`), so switch the sort key to the bare `embedding <=> $vec` ASC and
return similarity as a select column — an identical ordering, an index scan instead of a seq
scan, and one other consumer (`/api/search/semantic`) that only gets faster. Then add
`findSimilarBuilderEmbeddingsForMatch` (multi-vector, returns `document`) and
`findRestrictedIdentityPairs(pairs)` on the same corrected ordering. Add the `jd_match` rate
card. Still no user-visible surface.

### Phase 4 — Match service (the two-stage orchestration)

`src/lib/match/match-service.ts#runJdMatch()`: extraction (tenant-scoped cache via
`tenantAiCacheKey`) → `embedTexts(probes)` → K HNSW queries → restriction filter → hard filters
→ RRF → pool cap 50 → cold-index ladder reusing `SEMANTIC_MIN_LOCAL_MATCHES` and
`searchBuilders` + `upsertEmbeddingStubs` → single batched rerank → citation verification →
backfill → `mode` decision. Every failure path resolves to a mode, never to an exception
escaping to the caller. Repository `src/shared/lib/repositories/jd-match-runs.ts` (tenant-scoped,
`withTenantContext` only, never the global `db`).

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
disabled. `/match` nav pill + the one-line `/search` empty-state cross-link.

### Phase 7 — Retention, disclosure, observability

Extend `processPendingDeletions`-adjacent purge in the existing legal worker to delete
`jd_match_runs` past `expires_at`. Add the job-description line to the privacy-policy processor
list. Add structured counters for `droppedEvidence`, unknown-candidate rate, mode distribution
and per-run token totals (redacted correlation only, never prompt text). Full
`pnpm test && pnpm type-check && pnpm lint && pnpm test:api-isolation:local` pass.

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
| Stage 1 is 6× slower than budgeted because the shared retrieval query never uses the HNSW index | Certain (today) | High | Measured defect in shipped code (`ORDER BY (1 - (embedding <=> $v)) DESC` → seq scan + sort). Phase 3 fixes the sort key in place to the indexable `embedding <=> $v` ASC — an order-preserving change — with an `EXPLAIN` gate on the SQL Drizzle actually emits and a `/api/search/semantic` regression test |
| Correcting a shared function regresses semantic search | Low | High | Distance-ASC and similarity-DESC are the same ordering and the returned shape is unchanged, so the fix is observationally neutral; `look-alike-sourcing` needs the identical change, so whichever plan lands first owns it and the other asserts it rather than forking a second copy |

## Rollback

- **Phases 1–3** are invisible: drop `jd_match_runs` (single additive table, nothing else
  references it), remove the two task registry entries and the `jd_match` rate card. No shipped
  behaviour touched — the extension to `public-builder-embeddings.ts` is additive and the
  existing `findSimilarBuilderEmbeddings` is unmodified.
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
