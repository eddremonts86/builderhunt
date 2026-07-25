# Code-Style Fingerprinting — v2 AI Upgrade (plan)

> **Status**: `partially-implemented` (v1 heuristic shipped; phases below are the v2 work)
> **Depends on**: [`ai-expansion`](../ai-expansion/spec.md)
> **Blocks**: [`team-synergy`](../team-synergy/spec.md) (soft), [`work-sample`](../work-sample/spec.md) (soft — shared `src/lib/github/content.ts`)
> **Reality check**: `src/shared/lib/code-style.ts` + `code-style.test.ts` + `src/shared/components/CodeStyleCard.tsx` are live (client-side heuristic, nothing persisted). The AI platform (`src/shared/lib/ai/*`, `/api/ai/*`) must exist through its Phase 3 before Phase 2 here.

## Delivered (v1 — do not re-plan)

- Heuristic fingerprint generator and `similarity()` — `src/shared/lib/code-style.ts`, tested.
- Profile card rendering the fingerprint — `src/shared/components/CodeStyleCard.tsx`,
  mounted in `BuilderProfilePage.tsx`.
- Pricing promise — "Code fingerprinting" under Pro in `billing-shared.ts`.

## Phases (v2)

### Phase 1 — GitHub content fetcher (no AI, independently shippable)

`src/lib/github/content.ts`: repo selection, tree walking, candidate-file filtering/ranking,
blob fetching, and the pure pre-stats functions (`testFileRatio`, `avgCommentDensity`,
exclusion regex, ranking comparator). Pure parts unit-tested against fixture trees. This
module is deliberately task-agnostic — [`work-sample`](../work-sample/plan.md) reuses it.

### Phase 2 — Task registration + generation endpoint

Register `fingerprint-v2` in `src/shared/lib/ai/tasks.ts` (schemas, prompt, allowances
`{ free: 0, pro: 20, team: 40 }`, TTL 30 d). Build
`POST /api/builders/$builderId/fingerprint` implementing the 10-step flow from the spec,
persisting the versioned envelope to `builders.metadata.codeStyleFingerprint` via `jsonb_set`.

### Phase 3 — UI upgrade

`CodeStyleCard.tsx` renders stored v2 when present (caption, evidence bullets, relative
date), keeps v1 otherwise; "Analyze real code" button with plan-gate/budget/error states;
hidden per `/api/ai/config` degradation rules.

### Phase 4 — Match against my tracked builders (density-gated)

Sample-file fingerprinting (same task, single-sample input) + ranking the user's tracked
builders with the existing `similarity()`. UI appears only at ≥ 20 stored v2 fingerprints
among the user's tracked builders. Global cross-user matching stays cut (Future — see spec).

## Risks

| Risk                                    | Likelihood | Impact | Mitigation                                                                                                            |
| --------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| GitHub rate limits (13 req/generation)  | Medium     | Medium | Require `GITHUB_TOKEN`; hard request cap per generation; abuse rate limit 5/user/h; 30-day artifact freshness.        |
| Prompt injection via code comments      | High       | Medium | `wrapUntrusted` on every sample; system-prompt data-not-instructions rule; poisoned-fixture test.                     |
| Scores still feel arbitrary (LLM noise) | Medium     | Medium | Require `evidence` citations in the schema; temperature 0.2 (platform default); 30-day cache stabilizes repeat views. |
| v1/v2 shape drift breaks `similarity()` | Low        | High   | Model schema reuses v1 metric names/ranges; type-level compatibility test.                                            |
| Phase 4 demos empty (no density)        | High       | Low    | UI gated on ≥ 20 stored fingerprints with an explanatory hint; no dead search box.                                    |

## Rollback plan

- Task-level kill: `AI_DISABLED_TASKS=fingerprint-v2` — endpoint 503s, UI hides the analyze
  button, v1 heuristic card keeps rendering (no deploy needed).
- Persisted envelopes are inert data under one namespaced metadata key; safe to leave, or
  clear with a single `jsonb - 'codeStyleFingerprint'` update.
- Phase 4 UI is an isolated panel; removing it touches no other surface.
