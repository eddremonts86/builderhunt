# AI Sourcing Sprints (spec)

> **Status**: `implemented` \u2014 Phases 1-5 shipped and live-verified (see tasks.md for the
> full evidence trail). Two deliberate architectural deviations from this spec, both
> documented in tasks.md: (1) sprints are organization-scoped (`sourcingSprints.organizationId`
> via `withTenantContext`/`requireTenantPrincipal`), not the raw `userId`-keyed table this
> spec originally described \u2014 the codebase's real convention for every other tenant
> resource (alerts, saved queries) is organization-scoped, confirmed by reading
> `organization-alerts.ts` before implementing; (2) the worker processes one cell per
> organization per run (iterating every org, like `alerts-worker.ts`) instead of a global
> `FOR UPDATE SKIP LOCKED` lease across all organizations \u2014 nothing else in this codebase
> queries tenant tables outside a per-organization RLS context, so introducing that pattern
> here would have been new, untested architecture. Team sharing (Future phase) is
> unaffected by either deviation.
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md) (hard — tenant persistence, budgets, worker context, and RLS);
> [`ai-expansion`](../20-ai-expansion/spec.md) (hard — task registry,
> `ai()` client, budgets); [`semantic-search`](../21-semantic-search/spec.md) (soft — sprint
> results write through `upsertEmbeddingStubs`; the feature works without it);
> [`proactive-discovery`](../22-proactive-discovery/spec.md) (soft — same HTTP-cron
> cell-cursor worker pattern, no code dependency);
> [`team-accounts`](../26-team-accounts/spec.md) (soft — shared sprints are a Future phase).
> **Blocks**: nothing.
> **Reality check**: Zero sprint code exists (no `sourcing_sprints` tables, no
> `src/lib/agents/`, no `/sprints` routes). What DOES exist and is reused, not rebuilt:
> federated search `src/lib/search.ts#searchBuilders` (12 connectors, cached),
> `PersonResultCard` + track/untrack (`src/modules/search/`, `/api/builders/track`),
> tracked-state annotation (`src/shared/lib/tracked-builders.ts`), the HTTP-cron worker
> pattern (`src/routes/api/admin/alerts/run-worker.ts`), plan gating (`src/shared/lib/billing.ts`).
> The previous spec in this directory cited **fictional packages**
> (`@edd_remonts/ai-schadcn-chat`, `@shadcn-map/map`), Gemini APIs, autonomous scraping
> agents, and Devpost — all removed (Devpost has no viable API per `_meta/app-reality.md`;
> AI provider policy is `_meta/ai-policy.md`). The `assets/*.jpg` mockups remain useful
> visual direction for the wizard, minus the map pane.
>
> **v2 (2026-07-20)**: reconciling the shipped UI against the 4 reference mockups
> (`assets/*.jpg`) added: batch upload of up to **10** `.txt`/`.md` files (not the mockup's
> 500, and no PDF/DOCX — explicitly deferred, see Future), each parsed independently via
> `jd-parse` into its own criteria card in a queue; per-variant candidate counts and a
> variant-selection checkbox in the preview step; a chat-style history for `filter-refine`
> instead of a single input; and an honest cursor-based progress indicator (real
> `variantIndex`/`page` position, never a fabricated "Searching..." state). The map pane
> stays deferred to a separate Future pass (needs a bounded city/country → lat/lng lookup
> table + MapLibre GL; out of scope for this v2 pass).

## Problem

Turning a job description into good sourcing queries is manual expertise: read the JD,
extract skills/seniority/location, invent 2–3 query angles, run them across sources,
repeat next week to catch new people. Every step is mechanical enough to automate — but it
must be automated honestly: deterministic searches on a schedule, not "autonomous agents".

## Goal

A **sourcing sprint** = extracted criteria + a small set of AI-proposed query variants,
executed immediately for instant results, then re-executed by a background worker on cron
until a result quota is reached. Results accumulate in a dedicated table, deduped, shown
in a sprint dossier with tracked-state annotations and a local-AI refinement chat.

Flow (3 steps, one route):

1. **Ingest** — paste a JD or CV as text → `jd-parse` extracts structured criteria.
   **Privacy win, explicit**: `jd-parse` is local-first — on Chrome with built-in AI, the
   CV/JD text **never leaves the browser**; only the extracted criteria (skills, roles,
   seniority, locations) reach the server when a sprint is saved. Non-Chrome falls back to
   the server proxy, which sees only the user's own pasted text (allowed by policy rule 6).
2. **Decompose** — `criteria-decompose` proposes up to 4 named query variants (keywords +
   optional source/language/country hints) with a one-line rationale each. The user edits,
   discards, or accepts variants.
3. **Execute** — accepted variants run immediately via `searchBuilders` (results on
   screen in seconds), and saving the sprint enrolls it for background continuation.

## Non-goals (rethought hard)

- **No autonomous agents / scraping.** "Sprints" are saved query variants executed by a
  deterministic cron worker against the same 12 public connectors search already uses.
  No LinkedIn, no Devpost/Indie Hackers (no viable APIs — blocked plans), no headless
  browsers.
- **No interactive map in v1 — CUT.** Reality: `RawBuilder.country` is populated almost
  exclusively by GitHub (`user.location`, free-text like "Berlin ish 🌍"), and by nothing
  on hn/devto/npm/lobsters/stackoverflow results (`src/lib/sources/*.ts`). No geocoding
  exists. A map over that data would be mostly-empty pins on lies. v1 ships a **location
  facet** (group-by on the raw `country` string) instead. If location data ever improves
  (normalization + coverage), a Future map phase uses **MapLibre GL** (real, open-source)
  — the fictional `@shadcn-map/map` is gone.
- **No fictional chat package.** The refinement chat is a plain input + message list of
  our own, backed by the `filter-refine` AI task. `@edd_remonts/ai-schadcn-chat` is gone.
- **No file parsing in v1.** Paste text (and `.txt` drop). PDF/DOCX extraction is a Future
  phase — it needs a client-side extraction library choice and is not required to prove
  the flow.
- **No LLM grading of candidate code.** The old "vetting engine" overlaps
  [`code-fingerprinting`](../24-code-fingerprinting/spec.md) and
  [`work-sample`](../37-work-sample/spec.md); sprint result scoring is the search pipeline's
  existing heuristic score plus keyword-overlap — deterministic and free.
- **No per-user `builders` writes.** Sprint results are stored as `(source, sourceId)` +
  a public profile snapshot (the same identity convention as `builder_embeddings` and the
  team suite's `builder_lists`). Tracking a result uses the existing track endpoint.

## AI tasks (registered in `src/shared/lib/ai/tasks.ts`, per `_meta/ai-policy.md`)

### `jd-parse` — tier `local-first`

- **Input**: `z.object({ text: z.string().min(80).max(20000) })` — pasted JD/CV, wrapped
  in `wrapUntrusted` (JDs are frequently third-party text).
- **Output** (`ExtractedCriteria`):
  `z.object({ skills: z.array(z.string().min(1)).min(1).max(20), roles: z.array(z.string()).max(5), seniority: z.enum(['junior','mid','senior','unknown']), locations: z.array(z.string()).max(5), mustHaves: z.array(z.string()).max(8) })`
- **Cache TTL**: 24 h (server side; identical JD re-parse is free).
- **Allowances**: `{ free: 3, pro: 50, team: 100 }` /day. **maxOutputTokens**: 512.
- **Fallback**: Chrome AI → server proxy → on `AIUnavailableError` show a manual criteria
  form (chips input for skills/roles/locations) — the wizard still works with zero AI.
- **Note**: 20k chars can exceed Chrome's ~6k-token window; the client truncates the input
  to ~4k tokens for the local attempt and falls to the server for longer texts.

### `criteria-decompose` — tier `local-first`

- **Input**: `ExtractedCriteria` (the user's own reviewed criteria — not wrapped).
- **Output**: `z.object({ variants: z.array(z.object({ name: z.string().min(1).max(60), keywords: z.array(z.string().min(1)).min(1).max(8), sources: z.array(z.enum(SOURCE_NAMES)).optional(), language: z.string().optional(), country: z.string().optional(), rationale: z.string().max(300) })).min(1).max(4) })`
  — `SOURCE_NAMES` from `src/lib/sources/types.ts`; server re-validates client-supplied
  variants with the same schema before persisting.
- **Cache TTL**: 24 h. **Allowances**: `{ free: 3, pro: 50, team: 100 }`.
  **maxOutputTokens**: 768.
- **Fallback**: a deterministic rung — one variant built directly from
  `criteria.skills.slice(0, 4)` as keywords. The wizard never dead-ends.

### `filter-refine` — tier `local-first` (the chat)

- **Input**: `z.object({ filters: SprintFilterSchema, instruction: z.string().min(2).max(500) })`
  where `SprintFilterSchema = z.object({ keywords: z.array(z.string()).max(8), sources: z.array(z.enum(SOURCE_NAMES)).optional(), country: z.string().optional(), minFollowers: z.number().int().optional(), types: z.array(z.string()).optional() })`
  — pure JSON-state in, JSON-state out; the instruction is the user's own text.
- **Output**: `z.object({ filters: SprintFilterSchema, explanation: z.string().max(200) })`.
- **Cache TTL**: `null` (conversational, stateful input). **Allowances**:
  `{ free: 5, pro: 100, team: 200 }`. **maxOutputTokens**: 384.
- **Fallback**: on `AIUnavailableError` the chat panel hides; manual filter controls
  (which the chat merely drives) remain — the chat is sugar over visible state, never the
  only way to filter.

## Schema (Drizzle migration)

```ts
export const sourcingSprints = pgTable("sourcing_sprints", {
  id: text("id").primaryKey(), // randomId()
  userId: text("user_id")
    .notNull()
    .references(() => authUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  criteria: jsonb("criteria").$type<ExtractedCriteria>().notNull(),
  variants: jsonb("variants").$type<QueryVariant[]>().notNull(), // the accepted set
  status: text("status").notNull().default("active"), // active | paused | completed
  quota: integer("quota").notNull().default(200), // max accumulated results
  cursor: jsonb("cursor")
    .$type<{ variantIndex: number; page: number }>()
    .notNull()
    .default({ variantIndex: 0, page: 1 }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const sprintResults = pgTable(
  "sprint_results",
  {
    id: text("id").primaryKey(),
    sprintId: text("sprint_id")
      .notNull()
      .references(() => sourcingSprints.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    profile: jsonb("profile").$type<SprintProfileSnapshot>().notNull(), // public RawBuilder subset
    matchedVariant: text("matched_variant").notNull(), // variant name
    score: integer("score").notNull(), // search pipeline score 0–100
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    sprintSourceUnique: unique("sprint_results_unique").on(
      t.sprintId,
      t.source,
      t.sourceId,
    ),
  }),
);
```

`SprintProfileSnapshot` = the same public-fields shape as semantic-search's
`EmbeddedProfile` (username, displayName?, avatarUrl?, bio?, profileUrl, followersCount?,
language?, country?, topics) — enough to render a result card without refetching.
**No FK to `builders`** (it's per-user); tracked state is annotated per requesting user at
read time via `getTrackedBuilderIds` + `trackedKey`, exactly like `/api/search/builders`.

## Background worker (`POST /api/admin/sprints/run-worker`)

Clone of the alerts run-worker pattern; VPS cron **every 30 minutes**.

Each run:

1. Pick ≤ 3 `active` sprints, oldest `lastRunAt` first.
2. For each, execute **one cell** = `searchBuilders({ keywords: variant.keywords, sources:
variant.sources, language, country, page: cursor.page, perPage: 30 })` for the cursor's
   variant, then advance the cursor (page ≤ 3 per variant, then next variant; all variants
   exhausted → `completed`).
3. Insert new rows into `sprint_results` (`ON CONFLICT DO NOTHING` on the unique key),
   score = pipeline score; stop and mark `completed` when the sprint's result count ≥
   `quota`.
4. If semantic-search is deployed, fire-and-forget `upsertEmbeddingStubs(persons)` — sprint
   traffic feeds the global index like every other search path (touchpoint declared per
   conventions rule 5).
5. Stamp `lastRunAt`; return `{ sprintsRun, resultsAdded, completed: string[] }`.

Idempotent (unique key absorbs re-runs); deterministic (no LLM calls in the worker —
policy's "background = server-side MiniMax" applies only when AI runs in background;
this worker runs **no AI at all**).

Overlapping cron calls lease due rows with `FOR UPDATE SKIP LOCKED` and update a cursor
only when it still equals the leased value. Search happens outside the short lease
transaction. A failed cell leaves that cursor unchanged for retry; failures in one sprint
do not abort the other leased sprints. Semantic write-through is injected as an optional
adapter/no-op so this plan never imports a module that is absent when semantic-search has
not shipped.

Load math: 3 sprints × 1 search/run × 48 runs/day = ≤ 144 federated searches/day worst
case — same order as proactive-discovery, well within source limits.

## API and authorization contract

- `GET/POST /api/sprints`: owner-only list/create. Create persists only reviewed criteria
  and variants, never the raw JD/CV.
- `POST /api/sprints/preview`: authenticated, rate-limited immediate deterministic search;
  maximum four variants and 30 results per variant; no persistence and available on Free.
- `GET/PATCH/DELETE /api/sprints/$sprintId`: every lookup scopes by `(id, userId)` and
  returns the same 404 for absent and foreign IDs. PATCH supports pause/resume/name/quota;
  invalid lifecycle transitions return 409.
- `GET /api/sprints/$sprintId/results`: owner-only opaque-cursor pagination (`limit <= 100`),
  validated sort/filter fields, facets, and viewer-specific tracked annotations.
- `POST /api/admin/sprints/run-worker`: admin-only and accepts no caller-selected sprint.

All browser-produced AI output is untrusted at the API boundary and revalidated with the
same shared zod schemas. Raw CV/JD text is held only in component memory, excluded from
logs/analytics/DB, and sent to MiniMax only after explicit fallback copy is shown when local
Chrome AI cannot serve the request.

## Plan gating (billing touchpoint, conventions rule 7)

- `PLAN_LIMITS` (`src/shared/lib/billing-shared.ts`) gains
  `sourcingSprints: { free: 0, pro: 3, team: 10 }` (max **active** sprints) and
  `billing.ts` gains the corresponding `checkLimit` resource.
- The wizard itself (parse + decompose + immediate run, nothing persisted) is usable on
  free within the AI task allowances (`free: 3/day`) — a deliberate taste of the feature;
  **saving** a sprint requires Pro.
- `PLAN_PRICING.pro.features` gains "Sourcing sprints"; team copy gains "Shared sprints
  (coming later)" only when the Future phase lands — don't promise it yet.

## UX integration

- `/_dashboard/sprints/` — sprint list (name, status, results count, quota progress,
  pause/resume/delete) + "New sprint".
- `/_dashboard/sprints/new` — the 3-step wizard (Ingest → Variants → Run & save). Steps
  keep state client-side; nothing persists until "Save sprint".
- `/_dashboard/sprints/$sprintId` — the dossier: accumulated results as `PersonResultCard`
  grid (reused from `src/modules/search/`), track/untrack wired to the existing endpoints,
  sort by score/date, **location facet chips** (group-by raw `country`, "Unknown" bucket
  honest and visible), filter bar, and the refinement chat panel (`filter-refine`) that
  edits the visible filter state with an "applied: …" explanation line.
- AI download prompt: wizard step 1 renders `AIDownloadPrompt` (from ai-expansion) when
  Chrome AI is `downloadable`, with the "CV stays in your browser" line as the motivator.
- All AI surfaces hide per the platform config/degradation ladder; the manual criteria
  form and manual filters keep every step usable without AI.

## Cost model (per ai-policy)

- `jd-parse` + `criteria-decompose`: interactive, expected ≥ 70% Chrome AI. Server residue
  ~2k in / 0.5k out tokens per call, capped by allowances (pro 50/day each). Worst-case
  100 pro users maxing out ≈ 250k tokens/day — bounded, Pro-funded; realistically two
  orders of magnitude lower.
- `filter-refine`: small calls (~600 in / 250 out), uncached, allowance-capped.
- Worker: zero AI spend. Embedding write-through spend accounted by semantic-search
  (contentHash dedupe; sprints add ≤ quota × sprints new docs, bounded).

## Success metrics

- JD paste → first results on screen < 60 s (p75), including one local AI round-trip.
- ≥ 30% of saved sprints get ≥ 1 tracked builder from their dossier.
- Background continuation adds ≥ 25% more unique results vs the immediate run alone by
  sprint completion.
- Zero AI availability incidents that block the wizard (manual fallbacks verified).

## Resolved edge cases

- **Chrome window too small for a long CV**: client truncates to ~4k tokens for the local
  attempt, else server path (documented in the task note).
- **Model proposes invalid sources**: zod enum strips/fails → single retry (platform
  behavior) → deterministic fallback variant.
- **Duplicate results across variants of the same sprint**: unique
  `(sprintId, source, sourceId)` — first variant to find a person wins; `matchedVariant`
  records it.
- **Quota hit mid-run**: insert loop stops at quota, sprint marked `completed`; dossier
  shows "quota reached".
- **User downgrades with active sprints**: worker skips sprints whose owner's plan no
  longer allows any active sprints (limit check per run); dossiers stay readable.
- **Deleted sprint mid-run**: FK cascade removes results; worker's sprint fetch simply no
  longer sees it.
- **Same person tracked already**: dossier annotates tracked state (existing helper) and
  shows the untrack affordance with the correct per-user row id.
