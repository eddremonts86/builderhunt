# Work-Sample Analysis (plan)

> **Status**: `pending`
> **Depends on**: [`ai-expansion`](../ai-expansion/spec.md) (hard), [`code-fingerprinting`](../code-fingerprinting/spec.md) (soft — shared `src/lib/github/content.ts`; whichever ships first introduces it)
> **Blocks**: nothing. **Supersedes**: [`technical-sandbox`](../technical-sandbox/plan.md).
> **Reality check**: zero work-sample code exists despite the `PLAN_PRICING.team` promise. The old plan (Monaco simulator, AI teammate, `work_samples`/`work_sample_submissions` tables) is discarded — see the scope decision below. One new table, one task, two endpoints, one panel.

## Scope decision (recorded)

The old plan built a candidate-facing assessment simulator: companies author challenges,
candidates solve them in a browser IDE with a streaming AI teammate, an LLM grades
submissions. Cut because: (a) BuilderHunt has no candidate-side product — builders don't
log in to take tests; (b) it required streaming AI, which the platform v1 excludes; (c) the
pricing promise is "Work-sample _analysis_", which is a recruiter-side review of existing
public work. `technical-sandbox` (persona chat over a builder's code) is superseded into
this plan for overlapping reasons; its surviving kernel is the
`suggestedInterviewQuestions` output field.

## Phases

### Phase 1 — URL parsing + fetchers (no AI, independently testable)

Pure `parseSampleUrl` (repo/pr/file, reject everything else) + per-type fetchers in
`src/lib/github/work-sample.ts`, reusing selection heuristics from
`src/lib/github/content.ts` (introduce that module here if code-fingerprinting hasn't yet).
SSRF containment: only `api.github.com` requests built from parsed parts.

### Phase 2 — Schema + task registration

Drizzle migration for `work_sample_analyses` (unique `(userId, sampleUrl)`); register
`work-sample-analyze` in `tasks.ts` with the no-URL `superRefine`, maximal untrusted
wrapping, TTL 7 d, allowances `{ free: 0, pro: 0, team: 10 }`.

### Phase 3 — Endpoints

`POST /api/work-samples/analyze` (10-step flow from the spec, upsert semantics, `force`),
`GET /api/work-samples` (owner's list, optional `builderId` filter),
`DELETE /api/work-samples/$id` (owner-only).

### Phase 4 — Profile panel

`WorkSamplePanel.tsx` on `BuilderProfilePage.tsx`: input, progress, full review rendering,
previous-analyses list with re-analyze/delete, plan-gate and AI-unavailable states.

### Phase 5 — Hardening pass (ship gate)

Poisoned-fixture injection tests (README payload, PR-body payload, markup in file paths),
no-URL output enforcement test, truncation-caveat rendering, budget/rate-limit curls.
This phase is a release blocker, not polish — repo content is maximally untrusted.

## Risks

| Risk                                            | Likelihood | Impact | Mitigation                                                                                                                           |
| ----------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt injection from sample content            | High       | High   | Phase 5 gate: wrapUntrusted everywhere, no-URL superRefine, evidence-citation rule, poisoned fixtures.                               |
| Cost blowout (heaviest task)                    | Medium     | Medium | 10/day Team-only allowance, 3/h abuse limit, 7-day cache, persisted rows; `maxRepoFiles` 6→4 as first knob.                          |
| Review reads as authoritative hire verdict      | Medium     | High   | No numeric score in schema; evidence-cited signals; confidence field; disclaimer footer; red flags must be evidence-backed or empty. |
| Recruiter analyses leak to builders/other users | Low        | High   | Dedicated per-user table (never `builders.metadata`), owner-only GET/DELETE, no public rendering path exists.                        |
| Giant repos/diffs blow context                  | High       | Low    | Hard caps at every layer (6 files, 20 KB/file, 60 KB diff) + `truncated` flag + scoped-claims prompt rule.                           |

## Rollback plan

- `AI_DISABLED_TASKS=work-sample-analyze` → analyze endpoint 503s, panel hides its input
  (stored analyses remain readable via GET — they're the user's data).
- Full removal: drop the panel + endpoints + task entry; the table can stay (inert user
  data, covered by the existing account-deletion cascade via `userId`).
