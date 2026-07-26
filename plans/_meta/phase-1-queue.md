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
| 1 | `design-modernization` | 12 | Visual sweep; large but mechanical, and the token/`.card`/glass system already exists. |
| 2 | `portfolio-builder` | 12 | New public surface; builds on `published_builder_profiles`. |
| 3 | `unified-timeline` | 13 | New fetch/normalize layer across sources; also unblocks real event detection for `smart-alerts`. |
| 4 | `audit-conversion` | 14 | Funnel changes touching landing + pricing + onboarding together. |
| 5 | `solutions-intelligence` | 30 | Large new domain. |
| 6 | `calendar-scheduling-interview-intelligence` | 81 | Largest by far; new integrations + scheduling domain. |

## A1. Done this session (2026-07-26) — see each plan's tasks.md for full evidence

| Plan | What shipped | What's left, and why |
|------|-------------|----------------------|
| `content-marketing` | Post template, 2 new posts, real regression tests, `@tailwindcss/typography` install (real bug: every post's headings/code blocks rendered unstyled). | Phase 2/3 (cross-posting, ongoing cadence) is manual founder GTM work, not code — left for the user. |
| `claimable-profiles` | Replaced email-only claim "proof" with real source-bound verification (bio-challenge checked against the live GitHub/GitLab/Codeberg/DEV.to API). Admin revocation route. Live-verified against the real GitHub API. | Profile-view analytics (separate net-new feature) not built. |
| `audit-performance-qa` | Responsive AVIF/WebP hero images + budget checker script; confirmed tsc/eslint/fonts were already clean (stale plan text). | **Pending, needs your input**: Playwright/Lighthouse harness + CI quality-gate workflow. Blocked by two standing rules: no new e2e/Playwright files this session, and CI/CD pipeline edits (`.github/workflows/*`) need your explicit go-ahead before I touch them autonomously. Tell me if you want me to proceed on either. |
| `audit-trust` | Removed 6 real fabricated trust claims (fake 4.8★ rating, invented "420M+ profiles" stats, a fabricated testimonial, a hardcoded fake live-signal chip, a dead "Join Alerts" form, false user-PAT copy) — all with a source-level regression test. Claim-verification concern already closed by `claimable-profiles`. | **Pending, needs your input**: the full profile-removal/global-suppression subsystem (new tables, HMAC keys, source-proof adapters, enforcement across 8 consumer surfaces — `/security` and `/privacy/remove` pages, GDPR-style de-index). This is a large, security-critical feature comparable in size to `claimable-profiles` — deliberately not rushed. Also depends on the same CI/e2e-gated verify steps as above. Say the word and I'll scope it as its own pass. |

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
