# Team Synergy — Candidate-vs-Team Fit Analysis (tasks)

> **Status**: `pending`
> **Depends on**: [`ai-expansion`](../ai-expansion/spec.md) (hard), [`code-fingerprinting`](../code-fingerprinting/spec.md) (soft), [`ai-profile-enrichment`](../ai-profile-enrichment/spec.md) (soft), [`team-accounts`](../team-accounts/spec.md) (soft)
> **Blocks**: nothing
> **Reality check**: builds on `src/shared/lib/tracked-builders.ts`, `src/shared/lib/code-style.ts` (`generateFingerprint` fallback), and read-only access to `builders.metadata.codeStyleFingerprint` / `.aiEnrichment`. No DB changes.

## Phase 1 — Pure synergy lib

- [ ] **Team aggregate builder**
  - Files: `src/shared/lib/synergy.ts`, `src/shared/lib/synergy.test.ts`
  - Do: `buildTeamAggregate(rows)` — per row use stored v2 fingerprint
    (`codeStyleFingerprintV2Schema.safeParse` on `metadata.codeStyleFingerprint`) else
    `generateFingerprint(row)`; aggregate language shares, top-15 topics, paradigm
    distribution, metric means, seniority mix (only if ≥ 3 enriched members),
    `aiFingerprintShare`. Pure over an in-memory row list; cap 50.
  - Verify: `pnpm test synergy` — fixtures: mixed v1/v2 members, no-enrichment team, 50-row cap.
- [ ] **Deterministic baseline**
  - Files: `src/shared/lib/synergy.ts`, `src/shared/lib/synergy.test.ts`
  - Do: `computeSynergyBaseline(candidate, team)` per spec rules (language bridge +20,
    complementary-gap up to +40, paradigm fit +10/+20, topic Jaccard up to +20), clamp
    0–100, ≤ 6 notes.
  - Verify: tests for clamping, monotonicity (gap-filling candidate never lowers the complementarity component), and note generation.

## Phase 2 — Task registration

- [ ] **Register `synergy-analysis`**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: input/output zod schemas from the spec (share `codeStyleMetricsSchema` with
    code-style types), system prompt (baseline anchor ±15, constructive friction,
    confidence rule, untrusted rule), `buildPrompt` wrapping `candidate.bio`/`topics` in
    `wrapUntrusted`, tier `server-only`, `cacheTtlSeconds: 86_400`,
    allowances `{ free: 0, pro: 0, team: 25 }`, `maxOutputTokens: 600`.
  - Verify: `pnpm test tasks` — registry integrity + a poisoned-bio fixture is wrapped.

## Phase 3 — Endpoint

- [ ] **Synergy endpoint**
  - Files: `src/routes/api/builders/$builderId/synergy.ts`
  - Do: POST implementing the spec's 8 steps — ownership check; kill-switch/key → 503;
    budget → on 429 `budget`/`plan` still compute and return `{ baseline, degraded: true }`
    only for `budget` (plan-gated users get the 429 with upgrade copy);
    `rateLimit('synergy', userId, 10, 3600)`; load tracked rows (exclude the candidate),
    `teamTooSmall` under 2; baseline + input assembly; platform call; AI failure →
    `{ baseline, degraded: true }`. Nothing persisted.
  - Verify: curl as team user → full analysis; as pro user → 429 `plan`; with
    `AI_DISABLED_TASKS=synergy-analysis` → `degraded: true` baseline; with 1 tracked
    builder → `teamTooSmall: true`.

## Phase 4 — UI

- [ ] **TeamFitCard**
  - Files: `src/modules/builder-profile/components/TeamFitCard.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: collapsed "Analyze team fit against your {n} tracked builders" trigger; states:
    loading, AI result (score badge, summary, adds/overlaps/friction lists, confidence
    pill), degraded (baseline score + notes, "rule-based estimate" badge), too-small hint,
    plan-gated upgrade prompt. Hide the trigger when the user has < 2 tracked builders.
    `data-testid="team-fit-card"` / `"team-fit-mode"`.
  - Verify: UI check of all five states; mode testid reflects `ai` vs `baseline`.
- [ ] **Pricing copy (optional polish)**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: add "Team fit analysis" bullet to `PLAN_PRICING.team.features` (marketing only —
    the enforcement gate is the task allowance, not `PLAN_LIMITS`).
  - Verify: /pricing renders the bullet; `pnpm test` green.

## Phase 5 — Org lists (blocked on team-accounts — do not start)

- [ ] **Org list as team source**
  - Files: `src/routes/api/builders/$builderId/synergy.ts`
  - Do: accept `{ teamSource: 'tracked' | { orgListId } }`; fetch org list rows (membership
    check via team-accounts helpers) and feed the same `buildTeamAggregate`.
  - Verify: org member gets an analysis against the shared list; non-member 403.
