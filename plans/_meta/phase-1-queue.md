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

*(empty — see A2 below: both remaining plans are blocked on an unresolved dependency, not just large)*

## A1. Done this session (2026-07-26) — see each plan's tasks.md for full evidence

| Plan | What shipped | What's left, and why |
|------|-------------|----------------------|
| `content-marketing` | Post template, 2 new posts, real regression tests, `@tailwindcss/typography` install (real bug: every post's headings/code blocks rendered unstyled). | Phase 2/3 (cross-posting, ongoing cadence) is manual founder GTM work, not code — left for the user. |
| `claimable-profiles` | Replaced email-only claim "proof" with real source-bound verification (bio-challenge checked against the live GitHub/GitLab/Codeberg/DEV.to API). Admin revocation route. Live-verified against the real GitHub API. | Profile-view analytics (separate net-new feature) not built. |
| `audit-performance-qa` | Responsive AVIF/WebP hero images + budget checker script; confirmed tsc/eslint/fonts were already clean (stale plan text). | **Pending, needs your input**: Playwright/Lighthouse harness + CI quality-gate workflow. Blocked by two standing rules: no new e2e/Playwright files this session, and CI/CD pipeline edits (`.github/workflows/*`) need your explicit go-ahead before I touch them autonomously. Tell me if you want me to proceed on either. |
| `audit-trust` | Full plan now closed. Removed 6 real fabricated trust claims (fake 4.8★ rating, invented "420M+ profiles" stats, a fabricated testimonial, a hardcoded fake live-signal chip, a dead "Join Alerts" form, false user-PAT copy). Then, in a dedicated follow-up pass: the entire profile-removal/global-suppression subsystem — two new GRANT-only tables, rotating HMAC keys, source-proof adapters (github/gitlab/codeberg/devto), the request/verify service (256-bit challenges, enumeration-resistant, cross-org `builders` deletion on verify), a read-time suppression filter wired into search/track/public-profile/recent/exports (recommendations/feeds/alerts covered transitively via `searchBuilders`), two public API routes, and real `/security` + `/privacy/remove` pages. Live-verified end-to-end against the real GitHub API. | Nothing pending except two items that only make sense after a maintainer decides to turn `PROFILE_REMOVAL_ENABLED` on in production (a runtime readiness gate + staged rollout) — the flag itself, off by default, is the safety net until then. |
| `design-modernization` | Verified every Wave 1/2 task against real source (they were already done — the tasks.md checkboxes had just never been updated) and fixed one real drift: `BrandLogoMark.tsx` had a cyan dot at a hardcoded hex that had silently drifted from the actual `--color-bh-cyan` token. Routed through CSS vars, pixel-verified identical output. | Nothing pending — plan fully closed. |
| `portfolio-builder` | Verified-owner public portfolio pages at `/portfolio/$claimId` (theme, headline, intro, up to 6 selected projects), fail-closed public API, owner draft/publish/unpublish UX, cache invalidation on revoke. Two real bugs found+fixed live: publish didn't save in-progress draft edits first; the public route was missing `<ThemeProvider>` so it always rendered light. | AI-persona/timeline integrations left as honest `false` stubs (both genuinely optional); e2e task out of scope this session. |
| `unified-timeline` | Per-builder "Recent activity" section on the profile page — live, read-through-cached (6h TTL) fetch from github/hn/devto/gitlab/stackoverflow's own public APIs, all 4 phases including the optional AI summary. Real bug found+fixed live: GitHub's public events feed never includes a PR's title/html_url (confirmed against the real API) — every PR event rendered blank; fixed by building the title/URL from the event's own `number` + repo name. | Nothing pending — plan fully closed. |
| `audit-conversion` | Full first-party consent-aware conversion-event pipeline (closed schema, privacy-minimized table, ingestion route, 30-day retention, admin aggregate reporting w/ Wilson-score CIs), hero guest-value CTA + tertiary "how it works" demotion, accurate source-count copy, fixed `/search`→`/explore` SearchAction JSON-LD. Two real bugs found+fixed live: `/explore`'s `next` param was silently dropped by `SignUpPage.tsx` (every guest-search signup lost its query); root JSON-LD SearchAction pointed at the authenticated-only `/search`. Live-verified full guest→signup→onboarding-skip→restored-search flow end to end. | **Pending, needs your input**: real baseline collection (needs ≥14 real days/1,000 sessions once `CONVERSION_EVENTS_ENABLED=true` is deployed), the `test:conversion` Playwright script + CI workflow gate (blocked by the same two standing rules as `audit-performance-qa`'s deferred item), and the staged 10%/50%/100% rollout decision (depends on the baseline). Tell me if/when to turn collection on. |

## A2. Blocked, needs your decision (2026-07-26) — the entire remaining actionable queue

Both plans below explicitly hard-depend on `security-and-multitenancy`'s **completed, certified**
canonical tenant/RLS cutover ("for completed canonical tenant cutover/RLS" — their own words).
That plan sits in section C with 2 open items already flagged as **needing maintainer approval** —
i.e. this isn't a stale reality-check, the block is real and current. Both are also each a
multi-week, money-and-identity-critical platform build (new credit-ledger charges, cross-source
human-identity merging, a new calendar/audio/transcription pipeline) — exactly the kind of thing
where a shallow autonomous pass would do more harm than good (charging real credits for a fake
feature, merging the wrong people's identities). Recommend resolving `security-and-multitenancy`'s
2 approval-gated items first, or explicitly telling me to proceed despite the stated dependency.

| Plan | Open | Blocked on |
|------|-----:|-----------|
| `solutions-intelligence` | 30 | `security-and-multitenancy` (completed canonical tenant/RLS gates — not yet certified) + `stealth-scraping` (itself dark/inactive, `ENRICHMENT_ENABLED=false`) + a 60-brief gold-set quality bar before any of it can be trusted. |
| `calendar-scheduling-interview-intelligence` | 81 | `security-and-multitenancy` (completed canonical tenant cutover/RLS) — largest plan in the whole backlog by a wide margin. |

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
