# AI Platform — Shared AI Layer (plan)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/plan.md) (tenant-scoped budgets, caches, artifacts, logs, and organization entitlements)
> **Blocks**: [`semantic-search`](../semantic-search/spec.md), [`ai-profile-enrichment`](../ai-profile-enrichment/spec.md), [`outreach-generator`](../outreach-generator/spec.md), [`code-fingerprinting`](../code-fingerprinting/spec.md), [`ai-sourcing-sprints`](../ai-sourcing-sprints/spec.md), [`team-synergy`](../team-synergy/spec.md), [`work-sample`](../work-sample/spec.md), [`proactive-discovery`](../proactive-discovery/spec.md)
> **Reality check**: No AI code exists. Builds on `src/shared/lib/redis.ts`, `rate-limit.ts`, `billing.ts`/`billing-shared.ts`, `env.ts`, and the auth/admin patterns in `src/routes/api/admin/alerts/run-worker.ts`.

## Phases (dependency order — shippable after each)

### Phase 0 — Config surface

Add the seven AI env vars to `src/shared/lib/env.ts` (all optional/defaulted, browser-safe
stubs like the existing ones). No behavior change; app boots identically with nothing set.

### Phase 1 — Pure core (registry, cache keys, budget logic) + tests

`tasks.ts` (types, `AI_TASKS` with only `ping`, `getTask`, `wrapUntrusted`),
`cache.ts` (`canonicalJson`, `cacheKeyFor`, Redis get/set), `budget.ts` (`decideBudget`,
`checkAndConsumeBudget` with in-memory fallback). Full vitest coverage of the pure functions.
No routes yet — nothing user-visible.

### Phase 2 — MiniMax server client

`minimax.ts`: `minimaxChat` (prompt-constrained JSON, zod validate, one retry), typed errors,
30 s timeout. `embeddings.ts`: `embedTexts` (OpenAI-compatible request, batch ≤ 64,
dim assertion against `env.AI_EMBEDDING_DIM`). Sibling tests mock `fetch`
with mocked `fetch` (no live key in CI).

### Phase 3 — API routes

`/api/ai/config` (GET, public-safe flags), `/api/ai/complete` (full 8-step pipeline:
kill switch → configured → auth → task+input validation → rate limit → budget → cache →
MiniMax), `/api/ai/embed` (admin-gated batch). Verified end-to-end with the `ping` task.

### Phase 4 — Client tier

`capabilities.ts` (SSR-safe detection), `local.ts` (Prompt API + `responseConstraint` +
zod re-validation), `client.ts` (`ai()` ladder with typed `AIUnavailableError`),
`useAICapabilities.ts` hook.

### Phase 5 — Download UX + hardening

`AIDownloadPrompt.tsx` (gesture-triggered download, progress, "use server instead"
preference), kill-switch verification pass, README-style usage doc-block at the top of
`tasks.ts` so feature plans integrate without reading this plan.

## Risks

| Risk                                                              | Likelihood              | Impact | Mitigation                                                                                           |
| ----------------------------------------------------------------- | ----------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| MiniMax API shape differs from assumptions (endpoints, JSON mode) | Medium                  | Medium | All provider specifics isolated in `minimax.ts`; verify against docs in Phase 2 before wiring routes |
| Chrome AI APIs change/renamed (they are Origin-Trial-era)         | Medium                  | Low    | All detection isolated in `capabilities.ts`; everything degrades to server tier                      |
| Budget counters drift when Redis is down                          | High (dev) / Low (prod) | Low    | Documented best-effort in-memory fallback, same trade-off as existing `rate-limit.ts`                |
| Model returns schema-invalid output persistently                  | Low                     | Medium | Single retry + 502 + feature-owned rule-based fallback; never crashes                                |
| Cost runaway from a buggy caller loop                             | Low                     | High   | Per-user daily budgets + 30/min abuse rate limit + `AI_DISABLED` kill switch                         |

## Rollback

- Phases 0–2 are dead code until Phase 3 — revert freely.
- Post-launch: set `AI_DISABLED=true` (instant, no deploy) or unset `MINIMAX_API_KEY`
  (server tier 503s, Chrome-capable clients keep local-only tasks). Full revert = delete
  `src/shared/lib/ai/`, the three `api/ai/*` routes, `AIDownloadPrompt.tsx`, and the env
  additions — no DB migrations exist in this plan, so rollback is code-only.
