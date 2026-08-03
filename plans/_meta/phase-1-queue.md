# Phase 1 — implementation queue

A dated snapshot of every `plans/phase-1/*` plan, ordered easiest → hardest, so a
session can pick up work without re-reading 54 `tasks.md` files.

This file answers "what can I pick up next". [`phase-1-order.md`](./phase-1-order.md) answers
the different question "in what sequence would all 54 be built from nothing" — that is where
each plan's `NN-` directory prefix comes from, and its counts are newer than the ones below
(regenerated 2026-07-28: `calendar-scheduling-interview-intelligence` is 9 open / 69 done, not
47/32; `audit-performance-qa` 1/9, not 7/4; `audit-visual-system` 2/8, not 3/7;
`exhaustive-local-e2e-design` 10/3, not 12/0). Plan names below are written without their
number prefix; the directories on disk carry it.

**Snapshot: 2026-08-03.** 54 plans, 781 tasks, 723 done (93%), 58 open, 38 plans fully closed.

Every table below this line is older than that count and disagrees with it. They are kept for the *ordering*
rationale, which is still useful; take no number from them. Regenerate with the command below.
(Stale on both axes now: `03-postgres-18-upgrade` joined phase-1 from phase-2 on 2026-07-28, making
it 54 plans and 787 tasks, and it is absent from every table below.)
Counts are `- [ ]` / `- [x]` lines in each plan's checklist. Regenerate with:

```bash
for f in plans/phase-1/*/tasks.md plans/phase-1/42-stealth-scraping/task.md; do
  p=$(basename $(dirname "$f"))
  o=$(grep -c "^- \[ \]" "$f" || true); d=$(grep -c "^- \[x\]" "$f" || true)
  printf "%3s|%3s|%s\n" "${o:-0}" "${d:-0}" "$p"
done | sort -t'|' -k1 -rn
```

Note `stealth-scraping` uses `task.md` (singular) and `implementation_plan.md` instead of the
`spec.md`/`plan.md`/`tasks.md` trio every other plan follows. The previous snapshot's one-liner
globbed only `tasks.md`, so that plan's 9 open items were invisible in every count. The command
above includes it explicitly; renaming the file is the real fix.

Open counts are a rough difficulty proxy only — a 9-task writing plan is far cheaper
than a 9-task schema+worker+UI plan. The ordering below is adjusted for real scope.

## A. Actionable queue (work these in order)

| Plan | Open | Why it is workable now |
|------|-----:|------------------------|
| `audit-visual-system` | 3 | Needs new e2e infra and a production check — **unblocked 2026-07-27** when the maintainer green-lit Playwright and CI-workflow edits. |
| `audit-performance-qa` | 7 | Lighthouse/Playwright harness plus a CI quality gate. Same green light. |
| `exhaustive-local-e2e-design` | 12 | Design waves 4+5 of the e2e suite. Same green light. Largest of the three but entirely additive. |
| `calendar-scheduling-interview-intelligence` | 47 | **Unblocked 2026-07-27**: its Phase 0 dependency (`security-and-multitenancy`'s canonical tenant/RLS cutover) is now closed. Phases 5–12 remain: private documents, live transcription, sensitive AI, retention, rollout. Still the largest plan in the backlog. |
| `solutions-intelligence` | 30 | Tenant dependency also cleared, but see section B — it retains two dependencies of its own. |

## A1. Recently closed

| Plan | What shipped |
|------|-------------|
| `security-and-multitenancy` (2026-07-27) | Canonical tenant cutover. `organization_id` is now `NOT NULL` on all seven tenant-private tables (`drizzle/0081`), with the migration adopting leftover rows itself so a forgotten backfill cannot take a release down. Fixed three real defects on the way: the resource backfill had never been run; `classifyResourceRow` flagged every team-owned row as a conflict; the readiness gate demanded a 24h zero-mismatch shadow window that could never be satisfied. Only the legacy-column contraction remains. |
| Test layout (2026-07-27) | All tests unified under `tests/{unit,e2e,regression}`. Not a plan item, but it moves the ground under `exhaustive-local-e2e-design` and `audit-performance-qa` — both write new Playwright files, which now belong in `tests/e2e`. |

## B. Blocked by another plan (do not start)

| Plan | Open | Blocked on |
|------|-----:|-----------|
| `shared-resources` | 10 | `team-accounts` (done) + its own header's "do not implement until…" note. The tenant-context half of its dependency is now satisfied; re-read the header before starting. |
| `activity-feed` | 7 | `shared-resources`. |
| `solutions-intelligence` | 30 | `stealth-scraping` (itself dark/inactive, `ENRICHMENT_ENABLED=false`) plus a 60-brief gold-set quality bar before any of it can be trusted. |

## C. Needs a decision, credential, or elapsed time — not more code

| Plan | Open | What it is waiting on |
|------|-----:|-----------------------|
| `waitlist-launch` | 9 | Manual go-to-market (Show HN, social, Search Console). Founder's runbook. |
| `stealth-scraping` | 9 | Deploy dark → seven-day canary → approval. Code complete. |
| `audit-conversion` | 3 | ≥14 real days and 1,000 sessions with `CONVERSION_EVENTS_ENABLED=true`, then a rollout decision. |
| `audit-trust` | 2 | Only meaningful once a maintainer turns `PROFILE_REMOVAL_ENABLED` on. |
| `production-infrastructure` | 2 | Backup cron and off-site copy need production SSH. |
| `stripe-billing-platform` | 2 | Sandbox/Test Clock certification and the Denmark canary. |
| `security-and-multitenancy` | 1 | Legacy-column contraction: needs the compatibility window plus production actually running in canonical read mode. |
| `indiehackers-integration` | 2 | Closed by decision; the two remaining boxes are explicitly-optional follow-ups and inflate the count. |

## D. Single leftover task, each already investigated and parked

All of these are "done except one item that cannot be closed here". Don't re-open
them without new information.

| Plan | Leftover |
|------|----------|
| `smart-alerts` | AI digest wiring touches `src/shared/lib/email.ts` (reserved file). Task registered and inert. |
| `work-sample` | Live GitHub fetch + AI run need a real `GITHUB_TOKEN` / `MINIMAX_API_KEY`; neither configured. |
| `team-synergy` | Phase 5 carries its own "do not start" note. |
| `status-and-trust` | Optional, and touches a reserved file. |
| `huggingface-integration` | Explicitly-optional item only. |
| `sourcehut-integration` | Explicitly-optional item only. |
| `hashnode-integration` | Paused on a paid-API vendor decision (user decided: paused). |
| `ai-sourcing-sprints` | Phase 6's dedicated item — see plan header. |
| `abuse-and-usage-integrity` | Enforcement rollout closed out at "warn" by user decision. |

## E. Partially implemented, but no open tasks

These report a non-`implemented` status with zero unchecked boxes — the status line is
stale rather than the work being incomplete. Worth a reality check before trusting either.

`responsive-mobile-design`, `lobsters-integration`.

## F. Complete (no open tasks)

`ai-expansion`, `ai-profile-enrichment`, `audit-accessibility`, `bluesky-integration`,
`code-fingerprinting`, `codeberg-integration`, `design-modernization`, `devpost-integration`,
`gitlab-integration`, `legal-and-compliance`, `npm-registry-integration`, `onboarding-flow`,
`outreach-generator`, `pricing-and-billing` (superseded), `proactive-discovery`,
`producthunt-integration`, `project-hygiene`, `public-landing-pages`, `rss-feeds`,
`semantic-search`, `stack-overflow-integration`, `team-accounts`,
`technical-sandbox` (superseded), `unified-timeline`.

## Full count

| Open | Done | Plan |
|-----:|-----:|------|
| 47 | 32 | `calendar-scheduling-interview-intelligence` |
| 30 | 0 | `solutions-intelligence` |
| 12 | 0 | `exhaustive-local-e2e-design` |
| 10 | 0 | `shared-resources` |
| 9 | 30 | `stealth-scraping` |
| 9 | 0 | `waitlist-launch` |
| 7 | 4 | `audit-performance-qa` |
| 7 | 0 | `activity-feed` |
| 6 | 11 | `content-marketing` |
| 5 | 8 | `portfolio-builder` |
| 3 | 13 | `audit-conversion` |
| 3 | 7 | `audit-visual-system` |
| 2 | 49 | `stripe-billing-platform` |
| 2 | 17 | `production-infrastructure` |
| 2 | 12 | `claimable-profiles` |
| 2 | 8 | `audit-trust` |
| 2 | 1 | `indiehackers-integration` |
| 1 | 32 | `abuse-and-usage-integrity` |
| 1 | 22 | `ai-sourcing-sprints` |
| 1 | 18 | `security-and-multitenancy` |
| 1 | 15 | `status-and-trust` |
| 1 | 13 | `smart-alerts` |
| 1 | 8 | `work-sample` |
| 1 | 8 | `hashnode-integration` |
| 1 | 7 | `sourcehut-integration` |
| 1 | 7 | `huggingface-integration` |
| 1 | 6 | `team-synergy` |
| 0 | 19 | `ai-expansion` |
| 0 | 17 | `legal-and-compliance` |
| 0 | 17 | `design-modernization` |
| 0 | 16 | `semantic-search` |
| 0 | 14 | `audit-accessibility` |
| 0 | 13 | `unified-timeline` |
| 0 | 13 | `public-landing-pages` |
| 0 | 13 | `onboarding-flow` |
| 0 | 11 | `code-fingerprinting` |
| 0 | 10 | `stack-overflow-integration` |
| 0 | 10 | `responsive-mobile-design` |
| 0 | 10 | `proactive-discovery` |
| 0 | 9 | `team-accounts` |
| 0 | 9 | `outreach-generator` |
| 0 | 9 | `gitlab-integration` |
| 0 | 8 | `project-hygiene` |
| 0 | 8 | `npm-registry-integration` |
| 0 | 8 | `codeberg-integration` |
| 0 | 8 | `ai-profile-enrichment` |
| 0 | 7 | `rss-feeds` |
| 0 | 6 | `producthunt-integration` |
| 0 | 6 | `lobsters-integration` |
| 0 | 6 | `bluesky-integration` |
| 0 | 3 | `pricing-and-billing` |
| 0 | 3 | `devpost-integration` |
| 0 | 0 | `technical-sandbox` |
