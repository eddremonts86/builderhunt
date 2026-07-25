# Phase 1 — implementation queue

A dated snapshot of every `plans/phase-1/*` plan, ordered easiest → hardest, so a
session can pick up work without re-reading 52 `tasks.md` files.

**Snapshot: 2026-07-25.** Counts are `- [ ]` / `- [x]` lines in each plan's `tasks.md`.
Regenerate with:

```bash
for f in plans/phase-1/*/tasks.md; do p=$(basename $(dirname "$f")); o=$(grep -c "^- \[ \]" "$f"; true); d=$(grep -c "^- \[x\]" "$f"; true); printf "%3s|%3s|%s\n" "${o:-0}" "${d:-0}" "$p"; done | sort -t'|' -k1 -n
```

Open counts are a rough difficulty proxy only — a 9-task writing plan is far cheaper
than a 9-task schema+worker+UI plan. The ordering below is adjusted for real scope.

## A. Actionable queue (work these in order)

| # | Plan | Open | Why this position |
|---|------|-----:|-------------------|
| 1 | `content-marketing` | 9 | Mostly prose (blog posts) + a frontmatter template. Low technical risk, no schema. |
| 2 | `claimable-profiles` | 10 | Extends an existing shipped flow (`builder_claims` + claim/verify routes already live). |
| 3 | `audit-performance-qa` | 10 | Measurement + targeted fixes over existing pages; no new product surface. |
| 4 | `audit-trust` | 11 | Copy/proof surfaces over existing pages. |
| 5 | `design-modernization` | 12 | Visual sweep; large but mechanical, and the token/`.card`/glass system already exists. |
| 6 | `portfolio-builder` | 12 | New public surface; builds on `published_builder_profiles`. |
| 7 | `unified-timeline` | 13 | New fetch/normalize layer across sources; also unblocks real event detection for `smart-alerts`. |
| 8 | `audit-conversion` | 14 | Funnel changes touching landing + pricing + onboarding together. |
| 9 | `solutions-intelligence` | 30 | Large new domain. |
| 10 | `calendar-scheduling-interview-intelligence` | 81 | Largest by far; new integrations + scheduling domain. |

## B. Blocked by another plan (do not start)

| Plan | Open | Blocked on |
|------|-----:|-----------|
| `shared-resources` | 10 | `security-and-multitenancy` (canonical tenant context) + `team-accounts`. Its own header says "do not implement until…". |
| `activity-feed` | 7 | `security-and-multitenancy` + `team-accounts` + `shared-resources`. |

## C. Non-actionable for an autonomous coding session

| Plan | Open | Reason |
|------|-----:|--------|
| `waitlist-launch` | 9 | Manual go-to-market (Show HN, social, Search Console). Founder's runbook, not code. |
| `exhaustive-local-e2e-design` | 12 | Building new e2e/Playwright files is out of scope for this session series. |
| `audit-visual-system` | 3 | Remaining items need new e2e infra or a production deploy. |
| `security-and-multitenancy` | 2 | Final items flagged as needing maintainer approval. |
| `stripe-billing-platform` | 2 | Same — final items need maintainer approval. |
| `production-infrastructure` | 2 | Remaining items need production host / DB-role access. |
| `indiehackers-integration` | 2 | Closed — skipped by decision. |

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

## E. Complete (no open tasks)

`code-fingerprinting` (all 4 phases shipped 2026-07-25 — see its tasks.md for what is
verified vs. blocked on credentials),

`ai-expansion`, `ai-profile-enrichment`, `audit-accessibility`, `bluesky-integration`,
`codeberg-integration`, `devpost-integration`, `gitlab-integration`,
`legal-and-compliance`, `lobsters-integration`, `npm-registry-integration`,
`onboarding-flow`, `outreach-generator`, `pricing-and-billing` (superseded),
`proactive-discovery`, `producthunt-integration`, `project-hygiene`,
`public-landing-pages`, `responsive-mobile-design`, `rss-feeds`, `semantic-search`,
`stack-overflow-integration`, `team-accounts`, `technical-sandbox` (superseded).
