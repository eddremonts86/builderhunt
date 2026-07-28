# Team Synergy — Candidate-vs-Team Fit Analysis (tasks)

> **Status**: `implemented` (Phases 1-4; Phase 5 stays deferred per its own "do not start" note)
> **Depends on**: [`ai-expansion`](../20-ai-expansion/spec.md) (hard — complete), [`code-fingerprinting`](../24-code-fingerprinting/spec.md) (soft — v1 heuristic only, v2 hasn't landed), [`ai-profile-enrichment`](../23-ai-profile-enrichment/spec.md) (soft — complete), [`team-accounts`](../26-team-accounts/spec.md) (soft — complete)
> **Blocks**: nothing
> **Reality check (corrected 2026-07-25)**: builds on `src/shared/lib/tracked-builders.ts` (thin
> wrapper — the real row-listing function is `listOrganizationBuildersForTeamAggregate`, added by
> this plan), `src/shared/lib/code-style.ts` (`generateFingerprint` fallback — always used today,
> since v2 fingerprints don't exist yet), and read-only access to
> **`organization_builders.privateMetadata.codeStyleFingerprint` / `.aiEnrichment`** — not
> `builders.metadata` as the original spec/reality-check line said; that legacy table stopped
> being the live write path back in security-and-multitenancy (see `enrichment.ts`'s own doc
> comment). No new tables; one new repository function added to `organization-builders.ts`.

## Phase 1 — Pure synergy lib

- [x] **Team aggregate builder**
  - Files: `src/shared/lib/synergy.ts`, `tests/unit/shared/lib/synergy.test.ts`
  - Done: `buildTeamAggregate(rows)` — per row, a stored v2 fingerprint if
    `codeStyleFingerprintV2Schema.safeParse(row.privateMetadata.codeStyleFingerprint)` succeeds
    (never true today — no plan has shipped v2 yet, confirmed by grep), else
    `generateFingerprint(row)` (v1 heuristic, always used in practice). Aggregates language
    shares, top-15 topics, paradigm distribution, metric means, seniority mix (only when ≥ 3
    members carry `privateMetadata.aiEnrichment`), `aiFingerprintShare`. Pure over an in-memory
    row list, capped at 50. `codeStyleFingerprintV2Schema` itself is defined here (didn't exist
    anywhere in the repo before this plan).
  - Verify: `pnpm vitest run tests/unit/shared/lib/synergy.test.ts` — 14/14 passing: mixed v1/v2
    members (confirms the v2 mean pulls above the pure-v1 baseline), no-enrichment team
    (`seniorityMix: null`), 50-row cap, empty team (no crash).
- [x] **Deterministic baseline**
  - Files: `src/shared/lib/synergy.ts`, `tests/unit/shared/lib/synergy.test.ts`
  - Done: `computeSynergyBaseline(candidate, team)` — language bridge (+20 when a shared
    language covers ≥ 20% of the team), complementary-metric gap (up to +40, `Math.min(40, gap
    * 0.4)` — this scaling is exactly what keeps it monotonic in gap size), paradigm fit (+10
    majority-fit / +20 minority-but-present "healthy diversity" / 0 + friction note if
    absent), topic Jaccard overlap (up to +20). Clamped 0–100, ≤ 6 notes.
  - Verify: same test file — clamping at both ends, monotonicity (a candidate with a strictly
    larger metric gap never scores lower on that component — asserted directly against the
    scaling formula), language-bridge threshold (10% coverage → 0, 50% → +20), minority > majority
    paradigm scoring, absent-paradigm friction note, note cap.

## Phase 2 — Task registration

- [x] **Register `synergy-analysis`**
  - Files: `src/shared/lib/ai/tasks.ts`
  - Done: `synergyInputSchema`/`synergyOutputSchema` live in `synergy.ts` (imported into
    `tasks.ts`, mirroring `enrichment.ts`'s split) rather than sharing a
    `codeStyleMetricsSchema` from `code-fingerprinting` — that plan hasn't defined one yet, so
    `synergy.ts` defines `codeStyleMetricsSchema` itself. One deviation from the original input
    schema draft: `paradigms`/`seniorityMix` are modeled as objects of optional fields, not
    `z.record(enumSchema, ...)` — zod infers a record over a finite enum key as **fully
    required**, which doesn't match `buildTeamAggregate`'s actual output (only paradigms/tiers
    present in the team are reported). System prompt: baseline anchor ±15, constructive-framing
    rule for friction, confidence rule (`low` when `aiFingerprintShare < 0.3` or no enrichment),
    no-hire-verdict rule, untrusted-content rule for `candidate.bio`/`topics`. Registered in
    `AI_TASKS`, tier `server-only`, `cacheTtlSeconds: 86_400`, allowances
    `{ free: 0, pro: 0, team: 25 }`, `maxOutputTokens: 600`.
  - Verify: `pnpm vitest run tests/unit/shared/lib/ai/tasks.test.ts` — 15/15 passing (registry
    integrity checks, which the new task satisfies).

## Phase 3 — Endpoint

- [x] **Synergy endpoint**
  - Files: `src/routes/api/builders/$builderId/synergy.ts`,
    `src/shared/lib/repositories/organization-builders.ts` (new
    `listOrganizationBuildersForTeamAggregate`, ordered by tracking recency — the existing
    `listOrganizationBuilders` orders by the builder's own `lastSeenAt`, not when the org
    tracked them)
  - Done: ownership check via `findOrganizationBuilderByIdentity` (404 if the candidate isn't
    tracked in the caller's org — this is also how the profile page itself is reachable, so
    "candidate row must belong to the session user" and "must already be a tracked builder"
    are the same check in this codebase, not two). **Reordered from the spec's literal
    step list**: team aggregate + `teamTooSmall` check happens *before* any budget/kill-switch
    check (per the spec's own Team-aggregate section: "below that the endpoint returns
    `{teamTooSmall: true}` and no budget is spent" — this only holds if the check comes
    first). Budget `reason: 'plan'` → hard 429 (upgrade prompt, no analysis at all — matches
    user story 3, "Pro user sees an upgrade prompt"); every other non-success path (kill
    switch, no API key, `reason: 'budget'`, the `rateLimit('synergy', ..., 10, 3600)` abuse
    guard, or an `AIParseError`/`AIProviderError`/`AIDisabledError` from the model call) is a
    graceful 200 degrade to `{ baseline, teamSize, degraded: true }` — never a 5xx/429 for
    those. Nothing persisted anywhere in the flow.
  - Verify: **live-verified end to end via `curl`** against the real dev server + DB with a
    real signed-up account: tracked 1 candidate (Rust/async/systems) + 0 teammates →
    `{"teamTooSmall":true}`; tracked 2 more (Python/ml teammates) on the account's *free*-tier
    org → `POST .../synergy` → `429 {"error":"plan"}` (correct hard gate); bumped the same
    org's `organization_entitlements.tier` to `team` directly in the local DB (reverted after
    the test) → re-ran → `200 {"baseline":{"score":8,"notes":["Strong complexity control
    fills a gap...","No one on the team shares a functional style — possible friction"]},
    "teamSize":2,"degraded":true}` — the graceful kill-switch degrade (no `MINIMAX_API_KEY`
    configured locally), with baseline notes that are actually substantively correct for the
    real Rust-vs-Python-team fixture data (Rust's heuristic paradigm is `functional`,
    `complexityControl` 90 vs. the Python pair's pragmatic-paradigm mean). Also verified: 404
    for an unknown candidate id, 401 unauthenticated.

## Phase 4 — UI

- [x] **TeamFitCard**
  - Files: `src/modules/builder-profile/components/TeamFitCard.tsx`,
    `src/modules/builder-profile/components/BuilderProfilePage.tsx` (mounted next to
    `OutreachCopilot`; added a `GET /api/dashboard/stats` fetch to the existing loader
    `Promise.all` for `trackedBuildersCount`, since no other call on this page already
    carries that number)
  - Done: collapsed "Analyze team fit against your {n} tracked builders" trigger (component
    returns `null` — hidden entirely — when `trackedBuildersCount < 2`); on first expand,
    fires the POST and renders whichever of the five states the response maps to: loading,
    AI result (score badge colored by band, summary, "What they add"/"Where they
    overlap"/"Possible friction" lists, confidence pill, "vs your {n} tracked builders · AI"
    footer), degraded (baseline score badge + notes + "rule-based estimate" badge), too-small
    hint, or the Team-plan upgrade prompt (429 `plan`). `data-testid="team-fit-card"` /
    `"team-fit-toggle"` / `"team-fit-mode"` (carries `data-mode` reflecting `ai`/`baseline`/
    `teamTooSmall`/`plan`/`error`/`loading`).
  - Verify: `pnpm tsc --noEmit` / `pnpm eslint .` clean on all new/touched files (0 errors,
    same 107 pre-existing warnings as before this plan). Full state-machine logic reviewed
    against the exact same response shapes live-verified via `curl` above (teamTooSmall,
    plan-gated 429, degraded 200) — every branch the component handles was actually produced
    by the real endpoint in this session, not just asserted in isolation. The component's own
    in-browser click-through was **not** independently verified: this session's interactive
    browser tool could not complete a sign-in/sign-up form submission against this dev server
    (reproduced identically across a stale tab, a cleared tab, and a brand-new tab — a
    pre-existing tool/dev-server interaction issue documented earlier this session during
    `public-landing-pages`, unrelated to this plan's code).
- [x] **Pricing copy**
  - Files: `src/shared/lib/billing-shared.ts`
  - Done: added `'Team fit analysis'` to `PLAN_PRICING.team.features`, between `'Work-sample
    analysis'` and `'Activity feed'`.
  - Verify: `pnpm vitest run` — full suite green (2036/2036 passing, 14 new synergy tests, no
    regressions).

## Phase 5 — Org lists (still not started)

- [ ] **Org list as team source**
  - Files: `src/routes/api/builders/$builderId/synergy.ts`
  - Do: accept `{ teamSource: 'tracked' | { orgListId } }`; fetch org list rows (membership
    check via team-accounts helpers) and feed the same `buildTeamAggregate`.
  - Verify: org member gets an analysis against the shared list; non-member 403.
  - **Note**: this plan's own header still says "blocked on team-accounts — do not start" —
    `team-accounts` has since shipped (`done`, 2026-07-22), so the technical blocker is gone,
    but this phase was left untouched per that explicit instruction rather than reinterpreted
    unilaterally. `buildTeamAggregate` already accepts a plain row list, so Phase 5 is a small,
    additive follow-up whenever a maintainer wants it — not a blocker for anything else.
