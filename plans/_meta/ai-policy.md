# AI Policy — LLM Architecture for All Plans

Binding decision (2026-07-19): BuilderHunt uses a **two-tier hybrid AI architecture**.
Every plan that touches AI must conform to this document.

All AI work also follows [`security-policy.md`](./security-policy.md): tenant-private inputs,
budgets, cache keys, persisted artifacts, and logs use the server-resolved active organization;
global-public embeddings contain no tenant notes, searches, contact data, or private enrichment.

## The two tiers

### Tier 1 — Chrome built-in AI (DEFAULT)

Client-side, on-device Gemini Nano via Chrome's built-in AI APIs:
`LanguageModel` (Prompt API), `Summarizer`, `Writer`, `Rewriter`, `Translator`,
`LanguageDetector`. Zero API cost, zero latency-to-network, private by default.

Use it for anything that is **ephemeral, per-user, and interactive**:

- Natural-language → search keywords/filters translation (semantic search UX).
- Outreach draft generation and rewriting (tone changes, shortening).
- On-screen summarization of already-fetched profile data.
- Chat-style refinement in the sourcing workspace.
- Explaining scores/fingerprints to the user.

Constraints to design around:

- Only available in Chromium browsers with the model downloaded; availability is a runtime
  question (`LanguageModel.availability()` → `available | downloadable | downloading | unavailable`).
  First use may require a user-gesture-triggered model download.
- Chrome's API release stage varies by surface and version, the Prompt API for web remains
  under active development, and foundation-model APIs are desktop-only. Feature detection
  and the MiniMax/manual fallback are product requirements, not temporary compatibility
  code. Never advertise local AI as universally available.
- Structured output via `responseConstraint` (JSON schema) — always constrain, always
  zod-validate the parsed result anyway.
- Small context window (~6k tokens usable). Feed it curated snippets, never raw dumps.

Implementation references (verified 2026-07-20):
[Chrome built-in AI requirements and API stages](https://developer.chrome.com/docs/ai/get-started),
[Prompt API availability, download, and structured output](https://developer.chrome.com/docs/ai/prompt-api).

### Tier 2 — MiniMax 3 (EXTERNAL, server-side)

MiniMax's chat + embeddings APIs, called ONLY from the server (`src/shared/lib/ai/minimax.ts`).

Use it for anything that is:

1. **Persisted and shared** — artifacts stored in the DB and shown to other users
   (AI enrichment persona cards, LLM-grade code fingerprints, work-sample analyses).
   Rationale: shared artifacts must be generated server-side for consistency and because
   client-generated content is untrusted input.
2. **Background** — no browser available (proactive discovery worker, enrichment-on-claim,
   alert digests, sourcing sprints).
3. **Embeddings** — Chrome AI and MiniMax M3 do not expose the vector contract this app
   needs. Embeddings use one separate server-only, OpenAI-compatible adapter configured by
   `AI_EMBEDDING_URL` and `AI_EMBEDDING_MODEL`. This is vector infrastructure, not a second
   generative LLM. **Vector dimension is a single config constant**
   (`AI_EMBEDDING_DIM`, default 1536) — schema migrations and queries must read it from
   one place. Deployment runs a dimension preflight before the pgvector migration.
4. **Fallback** — when Chrome AI is unavailable, the client calls `/api/ai/*` which proxies
   to MiniMax. Feature parity is mandatory: no feature may be Chrome-only.

Exact model IDs are env-configured, never hardcoded outside the env default:
`MINIMAX_MODEL` (default `MiniMax-M3`, verified against the
[official MiniMax M3 API example](https://www.minimax.io/models/text/m3) on 2026-07-20;
confirm it still appears in `GET /v1/models` during deployment),
The embedding model has no hardcoded provider default: `AI_EMBEDDING_URL`,
`AI_EMBEDDING_MODEL`, and `AI_EMBEDDING_DIM` define one verified deployment contract.

## Decision rule (memorize)

> Interactive + ephemeral + this-user-only → Chrome AI, with `/api/ai` MiniMax fallback.
> Persisted, shared, or background language work → server-side MiniMax M3.
> Embeddings → the server-only embedding adapter. Always.

## Shared AI layer (built once by `plans/ai-expansion` = the AI Platform plan; everyone else imports it)

```
src/shared/lib/ai/
  capabilities.ts   # client: detect Chrome AI availability per API, cached
  local.ts          # client: promptLocal({system, input, schema}) — Chrome AI w/ JSON-schema output
  client.ts         # client: ai(task, input) — tries local.ts, falls back to POST /api/ai/complete
  minimax.ts        # server: minimaxChat({system, input, schema}) using MiniMax M3
  embeddings.ts     # server: embedTexts(texts[]) through the configured vector endpoint
  tasks.ts          # shared: registry of AI task definitions {id, system prompt, zod schema, tier policy}
src/routes/api/ai/complete.ts   # authed, plan-gated, rate-limited proxy → minimax.ts
src/routes/api/ai/embed.ts      # server-internal use mostly; authed admin/worker
```

Every AI feature is a **task** in `tasks.ts` (e.g. `query-translate`, `outreach-draft`,
`profile-enrich`, `fingerprint-v2`, `synergy-analysis`). A task declares: id, zod output
schema, prompt template, tier policy (`local-first` | `server-only`), cache TTL, and which
plan tiers may invoke it. UI code calls `ai('outreach-draft', input)` and never touches
providers directly.

## Non-negotiable platform rules

1. **Zod-validate every model output** against the task schema; retry once on parse failure,
   then fail gracefully (feature-specific empty state, never a crash).
2. **Cache**: server AI responses cached in Redis keyed by `hash(taskId + canonical input)`,
   TTL per task (enrichment 30d, query-translate 24h, outreach no-cache).
3. **Rate limits & budget**: per-user daily counters in Redis per task; limits by plan tier
   (free gets small allowances, pro/team more). 429 with a clear upgrade message.
4. **Kill switch**: `AI_DISABLED=true` env flag disables all AI endpoints and hides AI UI
   (server exposes flag via a config endpoint / route context). Per-task disable via
   `AI_DISABLED_TASKS=comma,list`.
5. **Prompt injection defense**: bios, READMEs, posts, and any external content are untrusted.
   Delimit them in prompts (`<untrusted>` blocks), instruct the model to treat them as data,
   and never allow external content to change the output schema or task.
6. **Privacy**: never send auth data, emails, or other users' private notes to MiniMax.
   Only public profile data + the requesting user's own inputs (job description, etc.).
7. **Graceful degradation ladder**: Chrome AI → MiniMax proxy → rule-based v1 (outreach,
   code-style, hygiene already have heuristic v1s — they remain the final fallback) → hidden.
8. **New env vars** (all optional; AI features hide when unset):
   `MINIMAX_API_KEY`, `MINIMAX_BASE_URL` (default `https://api.minimax.io`),
   `MINIMAX_MODEL`, `AI_EMBEDDING_URL`, `AI_EMBEDDING_MODEL`,
   `AI_EMBEDDING_API_KEY`, `AI_EMBEDDING_DIM=1536`, `AI_EMBEDDING_TIMEOUT_MS=30000`,
   `AI_DISABLED`, `AI_DISABLED_TASKS`.

## Cost model plans must include

Each AI plan's spec must estimate: calls/user/day, avg tokens per call, cache hit
expectations, and which tier absorbs the load. Rule of thumb: if ≥70% of invocations can
run on Chrome AI (Tier 1), the feature is nearly free to operate; server-only features
must justify their MiniMax spend against the plan tier that gates them (pro/team).
