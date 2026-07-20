# AI Platform — Shared AI Layer (tasks)

> **Status**: `in_progress` (Phase 0 config + task registry landed 2026-07-20)
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md) (tenant-scoped budgets, caches, artifacts, logs, and organization entitlements)
> **Blocks**: [`semantic-search`](../semantic-search/spec.md), [`ai-profile-enrichment`](../ai-profile-enrichment/spec.md), [`outreach-generator`](../outreach-generator/spec.md), [`code-fingerprinting`](../code-fingerprinting/spec.md), [`ai-sourcing-sprints`](../ai-sourcing-sprints/spec.md), [`team-synergy`](../team-synergy/spec.md), [`work-sample`](../work-sample/spec.md), [`proactive-discovery`](../proactive-discovery/spec.md)
> **Reality check**: No AI code exists. Reuses `src/shared/lib/redis.ts`, `rate-limit.ts`, `billing.ts`, `env.ts`, and the admin-auth pattern from `src/routes/api/admin/alerts/run-worker.ts`.

Ordered so the codebase builds, lints, and passes tests after every checkbox.

## Phase 0 — Config

- [x] **Add AI env vars to the env schema**
  - Files: `src/shared/lib/env.ts`
  - Do: Add `MINIMAX_API_KEY` (optional), `MINIMAX_BASE_URL` (default `https://api.minimax.io`),
    `MINIMAX_MODEL` (default `MiniMax-M3`; verify it still appears in MiniMax
    `GET /v1/models` during deployment), `AI_EMBEDDING_URL`, `AI_EMBEDDING_MODEL`, and
    `AI_EMBEDDING_API_KEY` (all optional),
    `AI_EMBEDDING_DIM` (`z.coerce.number().int().positive().default(1536)`),
    `AI_EMBEDDING_TIMEOUT_MS` (`z.coerce.number().int().positive().default(30000)`),
    `AI_DISABLED` (`z.enum(['true','false']).default('false')`),
    `AI_DISABLED_TASKS` (`z.string().default('')`). No browser stubs needed (all have
    defaults or are optional).
  - Verify: `pnpm type-check` passes; app boots with no new env set (`pnpm dev`).

## Phase 1 — Pure core + tests

- [x] **Create the AI task registry**
  - Files: `src/shared/lib/ai/tasks.ts`
  - Do: Define `AITaskId`, `AITier`, `AITaskDefinition` (fields: `id`, `tier`, `inputSchema`,
    `outputSchema`, `system`, `buildPrompt`, `cacheTtlSeconds: number | null`,
    `allowances: Record<PlanTier, number>`, `maxOutputTokens`) per spec.md; export
    `AI_TASKS` containing only the `ping` task (`server-only`, input `z.object({})`,
    output `z.object({ pong: z.literal(true) })`, allowances `{ free: 5, pro: 20, team: 20 }`,
    `cacheTtlSeconds: null`); export `getTask(id)`, `isTaskDisabled(id, env)`, and
    `wrapUntrusted(text)` (wraps in `<untrusted>` blocks, escapes literal `</untrusted>`
    occurrences). Pure module — no I/O imports. Top-of-file doc-block explains how feature
    plans register tasks.
  - Verify: `pnpm type-check`.

- [x] **Test the task registry**
  - Files: `src/shared/lib/ai/tasks.test.ts`
  - Do: Assert every registered task has a non-empty system prompt, allowances for all
    three plan tiers, positive `maxOutputTokens`; `wrapUntrusted` escapes embedded
    delimiters; `isTaskDisabled` honors `AI_DISABLED` and `AI_DISABLED_TASKS=a,b` lists.
  - Verify: `pnpm test tasks.test`.

- [x] **Create the response cache module**
  - Files: `src/shared/lib/ai/cache.ts`
  - Do: Export pure `canonicalJson(value)` (recursive key-sort) and
    `cacheKeyFor(taskId, input)` = `` `ai:cache:${taskId}:${sha256hex(canonicalJson(input))}` ``
    (node `crypto`); export `getCached(task, input)` / `setCached(task, input, output)`
    using `getRedis()` — no-ops returning null when Redis is unavailable; `setCached`
    uses `SET ... EX task.cacheTtlSeconds` and skips when `cacheTtlSeconds` is null.
  - Verify: `pnpm type-check`.

- [x] **Test cache key hashing**
  - Files: `src/shared/lib/ai/cache.test.ts`
  - Do: `canonicalJson` is key-order invariant (`{a:1,b:2}` ≡ `{b:2,a:1}`, nested);
    `cacheKeyFor` is stable across calls, differs across taskIds and across inputs;
    arrays keep order (order-sensitive inputs must differ).
  - Verify: `pnpm test cache.test`.

- [x] **Create the budget module**
  - Files: `src/shared/lib/ai/budget.ts`
  - Do: Export pure `decideBudget({ used, limit })` → `{ allowed, reason?: 'plan' | 'budget' }`
    (`limit === 0` → `plan`; `used >= limit` → `budget`; `Infinity` always allowed); export
    `checkAndConsumeBudget(principal, entitlement, task)` — Redis key
    `` `ai:budget:${principal.organizationId}:${principal.userId}:${task.id}:${utcDate}` ``,
    `INCR` + `EXPIRE 90000` on first hit,
    in-memory `Map` fallback modeled on `src/shared/lib/rate-limit.ts`. Returns
    `{ allowed, used, limit, reason? }`.
  - Verify: `pnpm type-check`.

- [x] **Test budget logic**
  - Files: `src/shared/lib/ai/budget.test.ts`
  - Do: `decideBudget` under/at/over limit, zero limit → `plan`, Infinity; in-memory
    fallback of `checkAndConsumeBudget` counts per user+task+day and blocks at the limit
    (inject date or use vi.useFakeTimers).
  - Verify: `pnpm test budget.test`.

## Phase 2 — MiniMax client

- [x] **Implement the MiniMax server client**
  - Files: `src/shared/lib/ai/minimax.ts`
  - Do: `minimaxChat({ system, prompt, schema, maxOutputTokens })` — POST
    `${env.MINIMAX_BASE_URL}/v1/text/chatcompletion_v2` (verify exact path/fields against
    MiniMax docs), `model: env.MINIMAX_MODEL`, temperature 0.2, and the JSON Schema in
    the prompt; do not depend on provider-side `response_format` for M3;
    parse → `schema.safeParse`; on failure retry once with a JSON-correction turn, then throw
    `AIParseError`. Use `AbortSignal.timeout(30_000)`, throw `AIDisabledError` when
    `MINIMAX_API_KEY` is unset,
    `AIProviderError(status, message)` on HTTP errors; never log the key.
  - Verify: `pnpm type-check`.

- [x] **Test MiniMax parsing and retry**
  - Files: `src/shared/lib/ai/minimax.test.ts`
  - Do: Mock global `fetch` (vi.stubGlobal): valid JSON → parsed output; schema-invalid
    first response + valid retry → success with exactly 2 calls; invalid twice →
    `AIParseError`; HTTP 500 → `AIProviderError`; the request uses `MiniMax-M3` and does not
    claim provider-side JSON Schema enforcement.
  - Verify: `pnpm test minimax.test`.

- [x] **Implement and test the embedding adapter**
  - Files: `src/shared/lib/ai/embeddings.ts`, `src/shared/lib/ai/embeddings.test.ts`
  - Do: Export `embedTexts(texts)` using `AI_EMBEDDING_URL`, `AI_EMBEDDING_MODEL`, and an
    optional bearer `AI_EMBEDDING_API_KEY`; send OpenAI-compatible `{ model, input }`, use
    `AI_EMBEDDING_TIMEOUT_MS`, batch
    at ≤64, sort `data[]` by index, and assert every vector length equals
    `AI_EMBEDDING_DIM`. Missing config throws `AIEmbeddingUnavailableError`; mismatch throws
    `AIDimensionMismatchError`. Keep this adapter independent of `minimax.ts`.
  - Verify: `pnpm test embeddings.test` covers missing config, 70-input batching, unordered
    response indexes, HTTP failure, and dimension mismatch.

## Phase 3 — API routes

- [x] **Add GET /api/ai/config**
  - Files: `src/routes/api/ai/config.ts`
  - Do: TanStack server route (same shape as `src/routes/api/health.tsx`); returns
    `{ disabled, disabledTasks, serverAI }` where `serverAI` = key set AND not disabled;
    `Cache-Control: public, max-age=60`. No auth, no secrets in the payload.
  - Verify: `curl localhost:3000/api/ai/config` → `{"disabled":false,...}`; flip
    `AI_DISABLED=true`, restart, → `{"disabled":true,...}`.

- [x] **Add POST /api/ai/complete**
  - Files: `src/routes/api/ai/complete.ts`
  - Do: Implement the 8-step pipeline from spec.md (kill switch 503 → unconfigured 503 →
    tenant principal 401/403 → task/input validation 400 →
    `rateLimit('ai-complete', organizationId + ':' + userId, 30, 60)`
    429 → `checkAndConsumeBudget` (plan from `getUserPlan` in `src/shared/lib/billing.ts`)
    429 with `{ error: 'plan' | 'budget', used, limit }` → cache hit
    `{ output, cached: true }` → `minimaxChat` + `setCached` → `{ output, cached: false }`;
    `AIParseError` → 502 `{ error: 'ai_parse_failed' }`).
  - Verify: with a real `MINIMAX_API_KEY` in `.env`, an authed
    `curl -X POST /api/ai/complete -d '{"taskId":"ping","input":{}}'` returns
    `{"output":{"pong":true},...}`; 6th call in a day as a free user returns 429 `budget`.

- [x] **Add POST /api/ai/embed**
  - Files: `src/routes/api/ai/embed.ts`
  - Do: Admin-only (copy the `ADMIN_USER_IDS` check from
    `src/routes/api/admin/alerts/run-worker.ts`); zod body
    `{ texts: z.array(z.string().max(8000)).min(1).max(64) }`;
    `rateLimit('ai-embed', organizationId + ':' + userId, 20, 60)`; respond
    call `embedTexts`; respond `{ embeddings, dim: env.AI_EMBEDDING_DIM }`; kill switch +
    unconfigured → 503.
  - Verify: authed admin curl with `{"texts":["hello"]}` returns one 1536-float vector;
    non-admin gets 403.

## Phase 4 — Client tier

- [x] **Implement Chrome AI capability detection**
  - Files: `src/shared/lib/ai/capabilities.ts`
  - Do: `getAICapability(api: 'prompt' | 'writer' | 'rewriter' | 'summarizer')` →
    availability enum via `LanguageModel.availability()` / `Writer.availability()` etc.,
    guarded feature-detection (`'LanguageModel' in globalThis`), memoized per api,
    `'unavailable'` under SSR. Export `resetCapabilityCache()` for tests/download flow.
  - Verify: `pnpm type-check`; in Chrome devtools console the exported fn resolves without
    throwing; in Firefox it returns `'unavailable'`.

- [x] **Implement local (on-device) prompting**
  - Files: `src/shared/lib/ai/local.ts`
  - Do: `promptLocal({ system, prompt, schema })` — `LanguageModel.create({ initialPrompts:
[{ role: 'system', content: system }] })`, `session.prompt(prompt, { responseConstraint:
z.toJSONSchema(schema) })`, `JSON.parse` + `schema.safeParse` (retry once with a
    correction prompt, then throw `AIParseError`); destroy the session in `finally`.
  - Verify: `pnpm type-check`; manual check in Chrome with the model downloaded (any
    trivial schema round-trips).

- [x] **Implement the unified ai() client entry**
  - Files: `src/shared/lib/ai/client.ts`
  - Do: `ai(taskId, input, opts?)` — validate input against the task's `inputSchema`;
    if tier `local-first`, no `forceServer`, no `bh-ai-prefer-server` localStorage flag, and
    prompt capability `available` → `promptLocal` with `task.system` +
    `task.buildPrompt(input)`, return `{ output, via: 'local' }`; otherwise/on failure →
    `fetch('/api/ai/complete')`; non-OK → throw `AIUnavailableError` with `reason` mapped
    from the response (`ai_disabled`→`disabled`, 429 body error → `plan`/`budget`,
    else `error`). Document rungs 3–4 (rule-based fallback, hide) as caller-owned.
  - Verify: `pnpm type-check`; in-browser `ai('ping', {})` returns
    `{ output: { pong: true }, via: 'server' }` (ping is server-only).

- [x] **Add the useAICapabilities hook**
  - Files: `src/shared/lib/ai/useAICapabilities.ts`
  - Do: React hook returning `{ status, ready, needsDownload, downloading,
downloadProgress, requestDownload, serverAI, disabled }` — combines
    `getAICapability('prompt')` with a fetched `/api/ai/config` (React Query or plain
    effect, 60 s stale). `requestDownload()` calls `LanguageModel.create({ monitor })`
    tracking `downloadprogress` events; must run inside a user gesture.
  - Verify: `pnpm type-check`; hook renders without crashing in a scratch component in
    both Chrome and a non-Chromium browser.

## Phase 5 — Download UX + hardening

- [ ] **Add the one-time model download prompt component**
  - Files: `src/shared/components/AIDownloadPrompt.tsx`
  - Do: Inline card driven by `useAICapabilities`: "Enable on-device AI" button (calls
    `requestDownload`), progress bar while `downloading`, "Use server instead" secondary
    action (sets `bh-ai-prefer-server=1` in localStorage), dismiss state in localStorage
    (`bh-ai-download-dismissed`). Renders `null` when `ready`, `disabled`, or dismissed.
    Follow existing card/button classes used in
    `src/modules/builder-profile/components/OutreachCopilot.tsx` (`card`, `btn-primary`,
    `btn-ghost`).
  - Verify: In Chrome with the model not yet downloaded, the card shows and the button
    starts a download with visible progress; in Firefox the card never renders.

- [ ] **Kill-switch and degradation verification pass**
  - Files: none (verification only)
  - Do: Run the matrix — (a) `AI_DISABLED=true`: `/api/ai/complete` and `/api/ai/embed`
    return 503, `/api/ai/config` reports disabled, `AIDownloadPrompt` hidden;
    (b) `AI_DISABLED_TASKS=ping`: only ping 503s; (c) no `MINIMAX_API_KEY`: 503
    `ai_unconfigured`, config `serverAI:false`; (d) Redis stopped: complete still works
    (no cache, in-memory budget).
  - Verify: All four scenarios behave as listed; `pnpm test && pnpm type-check && pnpm lint`
    clean.
