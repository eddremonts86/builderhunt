# Team Synergy — Candidate-vs-Team Fit Analysis (plan)

> **Status**: `implemented` (Phases 1–5 shipped per `tasks.md`; this header and spec.md's
> were never updated to match — corrected 2026-07-31)
> **Depends on**: [`ai-expansion`](../21-ai-expansion/spec.md) (hard), [`code-fingerprinting`](../25-code-fingerprinting/spec.md) (soft), [`ai-profile-enrichment`](../24-ai-profile-enrichment/spec.md) (soft), [`team-accounts`](../27-team-accounts/spec.md) (soft)
> **Blocks**: nothing
> **Reality check**: (2026-07-31) `src/routes/api/builders/$builderId/synergy.ts` is real and shipped, including Phase 5's org-list team source. Reads (never writes) `builders.metadata.codeStyleFingerprint` and `.aiEnrichment`; falls back to `generateFingerprint` from `src/shared/lib/code-style.ts` for members without stored artifacts. Ephemeral by design — no schema changes anywhere in this plan.

## Scope decision (recorded)

The old plan built builder-to-builder co-founder matchmaking with a `/match` route and
radar charts. Rewritten to **candidate vs team aggregate** — the recruiting product the
Team tier actually sells. Pairwise matchmaking is cut, not deferred (different product,
no paying persona).

## Phases

### Phase 1 — Pure synergy lib (shippable alone: powers a rule-based card even before AI)

`src/shared/lib/synergy.ts`: `buildTeamAggregate(rows)` (fingerprint fallback chain,
language/topic/paradigm/metric aggregation, seniority mix, `aiFingerprintShare`) and
`computeSynergyBaseline(candidate, team)` (scoring rules from the spec, clamped, with
notes). Fully unit-tested — this file has zero I/O.

### Phase 2 — Task registration

`synergy-analysis` in `src/shared/lib/ai/tasks.ts`: schemas, system prompt (baseline-
anchored ±15, constructive-friction rule, confidence rule), `wrapUntrusted` on candidate
bio/topics, tier `server-only`, TTL 86 400, allowances `{ free: 0, pro: 0, team: 25 }`.

### Phase 3 — Endpoint

`POST /api/builders/$builderId/synergy` implementing the spec's 8-step flow, including the
`teamTooSmall` and `degraded` (baseline-only) contracts. Nothing persisted.

### Phase 4 — UI

`TeamFitCard.tsx` on the builder profile page with all five states (result / degraded /
too-small / plan-gated / loading).

### Phase 5 — Team-accounts hookup

Accept an org list id as the team source; `buildTeamAggregate` already takes a row list, so
this is endpoint plumbing only.

Shipped 2026-07-29 (commit `6602f49`) — the "deferred until team-accounts ships" hold was lifted
once that plan shipped 2026-07-22, per `tasks.md`'s own note. This section previously still said
"deferred," corrected 2026-07-31.

## Risks

| Risk                                          | Likelihood | Impact | Mitigation                                                                                                                     |
| --------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Analyses read as confident noise on thin data | High       | High   | Deterministic baseline anchor (±15 model adjustment); `confidence` field forced low on heuristic-heavy input; min team size 2. |
| Friction phrasing offends (about real people) | Medium     | Medium | Prompt: constructive framing only; friction items capped at 4; output length caps.                                             |
| Cache never hits (teams churn)                | Medium     | Low    | Accepted: TTL 24 h is a bonus, not a dependency; cost model assumes mostly cold calls.                                         |
| Cross-user privacy leak via team data         | Low        | High   | Aggregate contains only numeric/enum rollups — no member names, bios, or notes; input schema structurally enforces it.         |
| Score inflation via candidate bio injection   | Medium     | Medium | `wrapUntrusted` + baseline anchoring; poisoned-fixture test.                                                                   |

## Rollback plan

- `AI_DISABLED_TASKS=synergy-analysis` → endpoint returns baseline-only (`degraded`) —
  feature degrades to the rule-based card, no deploy.
- Full removal = delete one card component + one endpoint + one task entry; no schema or
  metadata cleanup needed (nothing persisted).
