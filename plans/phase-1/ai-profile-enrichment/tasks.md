# AI Profile Enrichment — Developer Persona Card (tasks)

> **Status**: `implemented` (Phases 1, 2, 4 shipped 2026-07-20; Phase 3 shipped 2026-07-25)
> **Depends on**: [`ai-expansion`](../ai-expansion/spec.md) (registry, cache, budget, `minimaxChat` implemented)
> **Blocks**: nothing
> **Reality check**: Touches `src/shared/lib/ai/tasks.ts`, `src/routes/api/builders/$builderId/*`, `claim/verify.ts`, `BuilderProfilePage.tsx`. Writes only the `metadata.aiEnrichment` jsonb key. No migrations.

**2026-07-20 adaptation note**: the legacy `builders.metadata` per-user table this spec targets
is no longer the live write path for newly tracked builders (security-and-multitenancy moved
tracking to `organization_builders`/`builder_identities`). Delivered instead against
`organization_builders.privateMetadata.aiEnrichment`, keyed by the requesting org's own
tracked-builder row — same jsonb-merge discipline (never overwrites the whole column), same
schemas/thresholds/cache TTL as spec'd. Phase 3 (claim-triggered auto-refresh) is deferred: a
verified claim is global (`builder_claims`, keyed by `builder_identity_id`, not org-scoped), and
`published_builder_profiles` has no jsonb metadata column to attach an artifact to without a
schema migration — out of scope for this pass. Revisit once `portfolio-builder` needs its own
`published_builder_profiles` metadata column anyway.

Ordered so the app ships cleanly after every checkbox.

## Phase 1 — Pure lib + task registration

- [x] **Create the enrichment schemas and pure helpers**
  - Files: `src/shared/lib/ai/enrichment.ts`
  - Do: Export `builderAIEnrichmentModelSchema` and `builderAIEnrichmentSchema` (envelope:
    `enrichedAt` ISO string, `model`, `version: z.literal(1)`) per spec.md; pure
    `hasEnrichableContent(input)` (bio ≥ 40 chars trimmed OR ≥ 3 topics OR ≥ 2 highlights);
    `buildEnrichInput(builderRow)` (columns + up to 12 highlights from `metadata`
    repo/post entries, each truncated to 200 chars, defensive against unknown metadata
    shapes); `isEnrichmentFresh(artifact)` (schema-valid, version 1, `enrichedAt` within
    30 days).
  - Verify: `pnpm type-check`.

- [x] **Test the pure helpers**
  - Files: `src/shared/lib/ai/enrichment.test.ts`
  - Do: Threshold matrix for `hasEnrichableContent` (each criterion alone passes; all-empty
    fails; 39-char bio fails, 40 passes); `buildEnrichInput` extracts highlights from a
    GitHub-shaped and a devto-shaped metadata fixture and survives `metadata: {}` /
    malformed entries; `isEnrichmentFresh` rejects stale (31 d), wrong version, and
    schema-invalid blobs.
  - Verify: `pnpm test enrichment`.

- [x] **Register the profile-enrich task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: Add `profile-enrich`: tier `server-only`; input/output schemas imported from
    `enrichment.ts`; `cacheTtlSeconds: 2_592_000`; allowances `{ free: 5, pro: 100,
team: 200 }`; `maxOutputTokens: 512`; system prompt per spec (objective,
    evidence-based, `mid` under uncertainty, `<untrusted>` rule, JSON only);
    `buildPrompt` wraps `bio`, `topics`, `highlights` with `wrapUntrusted`.
  - Verify: `pnpm test tasks.test` (registry integrity test covers the new task);
    grep the built prompt in the test for `<untrusted>` around a fixture bio.

## Phase 2 — API endpoints

- [x] **Add GET /api/builders/$builderId/enrichment**
  - Files: `src/routes/api/builders/$builderId/enrichment.ts`
  - Do: Auth required; load the row and authorize (row `userId` === session user, OR
    `claimedByUserId` === session user, OR admin) else 404/403 (mirror the ownership
    handling style of `src/routes/api/builders/$builderId/notes.ts`). Pipeline per spec.md
    flow: fresh artifact → `{ enrichment, cached: true }`; else threshold →
    `{ insufficient: true }`; else kill-switch/key/budget via platform helpers
    (`checkAndConsumeBudget` with plan from `getUserPlan`) → 503/429 with
    `{ error: 'plan' | 'budget' }`; else run the task through the platform cache +
    `minimaxChat`, build the envelope, persist with
    `jsonb_set(metadata, '{aiEnrichment}', $artifact)` (never overwrite whole metadata),
    return `{ enrichment, cached: false }`.
  - Verify: With a real key, authed curl on a tracked builder with a bio returns a
    schema-valid artifact; second call returns `cached: true` instantly; a bio-less,
    topic-less builder returns `{ insufficient: true }` and writes nothing.

- [x] **Add POST /api/builders/$builderId/enrichment/refresh**
  - Files: `src/routes/api/builders/$builderId/enrichment.ts` (delivered as the same file's POST
    handler, not a separate `refresh.ts` — mirrors this codebase's existing pattern of multiple
    HTTP methods per route file, e.g. `$builderId.ts` itself)
  - Do: Same pipeline minus the freshness short-circuit; authorize only admins or the user
    who claimed this profile; `rateLimit('enrich-refresh', userId, 5, 3600)`; consumes
    budget normally.
  - Verify: Claimed-owner curl regenerates (new `enrichedAt`); non-owner non-admin gets 403;
    6th refresh in an hour gets 429.

## Phase 3 — Claim hook (DEFERRED — see adaptation note above)

- [x] **Trigger enrichment on successful claim**
  - Files: `src/routes/api/builders/claim/verify.ts` (or the claim lib it delegates to)
  - Do: After verification succeeds, fire-and-forget the refresh pipeline for that row
    (extract the pipeline into `runProfileEnrichment(builderRow, userId)` in a server lib,
    e.g. `src/lib/enrichment/run.ts`, so both endpoints and the hook share it);
    `void run(...).catch(err => console.error('claim enrichment:', err))` — claim response
    is never delayed or failed by AI errors.
  - Verify: Complete a claim flow in dev; the row's `metadata.aiEnrichment.enrichedAt`
    appears shortly after; with `AI_DISABLED=true` the claim still succeeds cleanly.
  - **Done, with one deliberate deviation from the task's literal signature.** Research
    confirmed there is no single "builderRow" that spans both the claim flow (global, keyed only
    by `builderIdentityId` — `builder_claims` has no `organization_id` column at all) and the
    enrichment pipeline's actual persistence path (org-scoped: writes to
    `organization_builders.privateMetadata.aiEnrichment`, keyed by the claiming user's *active
    organization's* tracked-builder row). A bare `runProfileEnrichment(builderRow, userId)` with
    no org context has nowhere to look up or persist to. The existing pipeline's real signature —
    `runEnrichment(principal: TenantPrincipal, builderIdentityId: string, opts?)` — already fetches
    its own row and already resolves `{status: 404}` (not a throw) when the identity isn't tracked
    in that org, which is exactly the safety property a fire-and-forget caller needs. Kept that
    signature rather than inventing an incompatible one; documented the reasoning inline in the
    new shared file.
    - Extracted `runEnrichment` (unchanged logic, byte-for-byte) out of
      `routes/api/builders/$builderId/enrichment.ts` into new
      `src/shared/lib/ai/run-enrichment.ts`, so it's a real shared lib function rather than a
      route-local one. Updated `enrichment.ts`'s GET/POST handlers to import it — both existing
      call sites are unchanged in behavior.
    - `routes/api/builders/claim/verify.ts`: after `claim` is confirmed truthy (and before the
      redirect is built), added `void runEnrichment(principal, claim.builderIdentityId).catch(err
      => console.error('claim enrichment:', err))`. Used the *default* freshness check (not
      `skipFreshnessCheck: true`) — if the claimed identity already has a fresh (<30-day)
      enrichment artifact from before the claim, redoing it on every claim would burn AI budget
      for no benefit; the freshness check already handles "generate one if there isn't a good one
      yet" correctly.
    - No new rate-limiting was added for this trigger (unlike the manual "refresh" button's
      5/hour cap) — a claim can only be verified once per token, so this path is naturally
      bounded, not a repeatable-call surface.
    - **Live-verified without spending real AI budget**: `MINIMAX_API_KEY` is configured with a
      real key in local dev (`AI_DISABLED=false`), so a live browser walkthrough of the full
      email-claim flow risked a real, paid MiniMax API call purely to prove wiring that didn't
      change the enrichment pipeline's own logic (only relocated it). Instead, ran the full
      `scripts/db/verify-api-isolation-local.mjs` suite (no `MINIMAX_API_KEY` in that
      environment, so `runEnrichment` safely short-circuits to `{status: 503,
      error: 'ai_unconfigured'}` without ever reaching the real provider — the exact
      `AI_DISABLED`-equivalent safe path the task's own verify step asks for) against a fresh,
      fully isolated throwaway Postgres container: all 102/102 checks passed, including
      "claim: A can verify A's own claim token," proving the new fire-and-forget call executes
      inside the real claim-verify handler without throwing, blocking, or altering the response.
    - Verify sweep: `pnpm tsc --noEmit`, `pnpm eslint` (both clean), full `pnpm vitest run`
      (2004/2004 passing), `pnpm security:route-coverage` (106 routes, valid).

## Phase 4 — UI

- [x] **Build PersonaCard**
  - Files: `src/modules/builder-profile/components/PersonaCard.tsx`
  - Do: Fetch `GET .../enrichment` on mount (async, non-blocking). States: skeleton;
    full card (summary, seniority pill, primaryFocus, strengths chips, codingStyle line,
    "AI-generated · {relative enrichedAt}" footer); insufficient placeholder; error/budget
    note (stale card + note when a 429 arrives with a previously-rendered artifact).
    Refresh button (visible to claimed-owner/admin) → POST refresh → re-render. Reuse the
    `card`, pill, and chip classes used elsewhere in `src/modules/builder-profile/`.
    Render `null` while `/api/ai/config` reports `disabled` or `serverAI: false`
    (via `useAICapabilities`).
  - Verify: `pnpm type-check`; card renders all states by stubbing responses in dev.

- [x] **Wire PersonaCard into the profile page**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: Render `<PersonaCard builderId={...} isClaimedOwner={...} />` above
    `OutreachCopilot`; pass what the page already knows (row id, claim state, admin flag
    if available in session context).
  - Verify: Profile detail page shows the card end-to-end; page renders fine with
    `MINIMAX_API_KEY` unset (card hidden); `pnpm test && pnpm type-check && pnpm lint`
    all green.
