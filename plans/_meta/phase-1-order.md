# Phase 1 — canonical build order (01→53)

Every directory in `plans/phase-1/` carries a two-digit prefix that is its position in this
order. The number answers one question: **if BuilderHunt had to be built again from an empty
repository, in what sequence would these 53 plans be executed so that no plan is ever started
before something it depends on exists?**

The same number is the review order. Auditing plan-vs-reality top-to-bottom means you always
read a plan after the plans it builds on, so "this claims to be implemented" can be checked
against a foundation you have already verified rather than assumed.

**Snapshot: 2026-07-28.** 53 plans, 748 tasks, 627 done (83%), 121 open, 26 plans with zero
open tasks. Regenerate the counts with the command in
[`phase-1-queue.md`](./phase-1-queue.md).

## How the order was derived

1. Each plan's `> **Depends on**:` header was parsed into a dependency edge.
2. The result was topologically sorted, then grouped into waves so that plans with no edge
   between them sit next to each other and can run in parallel.
3. Within a wave, cheaper and more foundational work comes first — a connector before the AI
   layer that consumes it, the design shell before the surfaces rendered inside it.

**One cycle exists in the headers and is broken deliberately.** `semantic-search` declares a
dependency on `proactive-discovery`, and `proactive-discovery` declares one on
`semantic-search`. `README.md`'s dependency graph resolves it as `SEMANTIC --> DISCOVERY`, so
`21-semantic-search` precedes `22-proactive-discovery`. This is the only place where a
`Depends on` header points forward instead of backward.

`30-pricing-and-billing` and `38-technical-sandbox` are `superseded`. They keep numbers because
they are still the decision record for why their scope moved (to `29-stripe-billing-platform`
and `37-work-sample`); they are read-only and nothing is executed from them.

## Wave 0 — foundation and truth (01–04)

Nothing else may be trusted until these are real. `01` gates almost the whole backlog; `04`
exists because the UI presented synthetic evidence as measured fact.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 01 | [`security-and-multitenancy`](../phase-1/01-security-and-multitenancy/spec.md) | 1/18 | — | Blocks 7 plans directly. Canonical tenant cutover shipped 2026-07-27 (`organization_id` `NOT NULL` on all seven tenant-private tables, `drizzle/0081`). Only leftover: `TENANT_READ_MODE` still defaults to `legacy` and no contract migration drops the legacy columns. |
| 02 | [`production-infrastructure`](../phase-1/02-production-infrastructure/spec.md) | 2/17 | 01 | Backup cron and off-site copy need production SSH — not more code. |
| 03 | [`legal-and-compliance`](../phase-1/03-legal-and-compliance/spec.md) | 0/17 | — | Hard deletion + external-AI disclosure. Must precede any production MiniMax traffic (`20`). |
| 04 | [`project-hygiene`](../phase-1/04-project-hygiene/spec.md) | 0/8 | — | **Closed 2026-07-28.** Fabricated `Math.random()` evidence removed; real GitHub signals plus an on-screen "estimated" label. |

## Wave 1 — shell and design foundation (05–07)

These touch the components every later surface renders through. Their own headers say to land
them before new UI is stacked on top.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 05 | [`design-modernization`](../phase-1/05-design-modernization/spec.md) | 0/17 | — | Unfinished dark→warm-light migration; feeds all five audits (`47`–`51`). |
| 06 | [`responsive-mobile-design`](../phase-1/06-responsive-mobile-design/spec.md) | 0/10 | — | Overlaps `49-audit-visual-system`'s unchecked "dashboard shell" task on the same file. |
| 07 | [`onboarding-flow`](../phase-1/07-onboarding-flow/spec.md) | 0/13 | — | `implemented`; the one plan whose status has never been in question. |

## Wave 2 — source connectors (08–19)

All independent of each other and of everything above except the tenant model. Ordered git
hosts → package registries → community platforms → credential/decision-gated.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 08 | [`gitlab-integration`](../phase-1/08-gitlab-integration/spec.md) | 0/9 | — | **Closed 2026-07-28**: `GITLAB_TOKEN` is documented in `.env.example`. |
| 09 | [`codeberg-integration`](../phase-1/09-codeberg-integration/spec.md) | 0/8 | — | **Closed 2026-07-28**: both Codeberg env vars documented. |
| 10 | [`sourcehut-integration`](../phase-1/10-sourcehut-integration/spec.md) | 1/7 | — | Remaining item is explicitly optional. |
| 11 | [`npm-registry-integration`](../phase-1/11-npm-registry-integration/spec.md) | 0/8 | — | **Closed 2026-07-28**: search runs on `registry.npmjs.org`, not npms.io. |
| 12 | [`huggingface-integration`](../phase-1/12-huggingface-integration/spec.md) | 1/7 | — | Remaining item is explicitly optional. |
| 13 | [`stack-overflow-integration`](../phase-1/13-stack-overflow-integration/spec.md) | 0/10 | — | **Closed 2026-07-28**: env documented and quota exhaustion logged. |
| 14 | [`lobsters-integration`](../phase-1/14-lobsters-integration/spec.md) | 0/6 | — | **Closed 2026-07-28**: JSON-only by decision; scraping enrichment is a closed non-goal. |
| 15 | [`hashnode-integration`](../phase-1/15-hashnode-integration/spec.md) | 1/8 | — | Paused on a paid-API vendor decision (decided: paused). |
| 16 | [`bluesky-integration`](../phase-1/16-bluesky-integration/spec.md) | 0/6 | — | Ships without credentials. |
| 17 | [`producthunt-integration`](../phase-1/17-producthunt-integration/spec.md) | 0/6 | — | Wired but dormant until a token is provisioned. |
| 18 | [`devpost-integration`](../phase-1/18-devpost-integration/spec.md) | 0/3 | — | Implemented, dark by default. |
| 19 | [`indiehackers-integration`](../phase-1/19-indiehackers-integration/spec.md) | 2/1 | — | Closed by decision; the two open boxes are optional follow-ups that inflate every count. |

## Wave 3 — the one AI platform (20)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 20 | [`ai-expansion`](../phase-1/20-ai-expansion/spec.md) | 0/19 | 01 | The only provider integration layer: task registry, Chrome capability UX, MiniMax client, structured-output validation, cache, budgets, kill switches. No feature-specific AI endpoint may exist before this. |

## Wave 4 — first AI value and search core (21–25)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 21 | [`semantic-search`](../phase-1/21-semantic-search/spec.md) | 0/16 | 01, 20 (+22, cycle) | Embeddings, pgvector, global external-profile index, cold-start fallback to federated search. |
| 22 | [`proactive-discovery`](../phase-1/22-proactive-discovery/spec.md) | 0/10 | 20, 21 | Populates the global index via an idempotent HTTP-cron worker. |
| 23 | [`ai-profile-enrichment`](../phase-1/23-ai-profile-enrichment/spec.md) | 0/8 | 20 | Persona Card shipped for tracked builders; header says claim-triggered auto-refresh was deferred, yet zero tasks are open. |
| 24 | [`code-fingerprinting`](../phase-1/24-code-fingerprinting/spec.md) | 0/11 | 20 | Header says v1 heuristic shipped and v2 AI analysis pending, yet zero tasks are open. |
| 25 | [`outreach-generator`](../phase-1/25-outreach-generator/spec.md) | 0/9 | 20 | v1 rule-based + v2 AI both shipped; rule-based stays the final fallback. |

## Wave 5 — organizations and shared ownership (26–28)

`01` supplies the organization model, RLS and entitlements. These three add the UX and the
mutations on top; none of them may create a competing organization model.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 26 | [`team-accounts`](../phase-1/26-team-accounts/spec.md) | 0/9 | 01 | **Closed 2026-07-28.** Switcher, Team settings and the full `api/organizations/` surface verified live. One known follow-up stays out of scope: a hook-ordering race can leave a fresh sign-up's session with `active_organization_id: null`. |
| 27 | [`shared-resources`](../phase-1/27-shared-resources/spec.md) | 10/0 | 01, 26 | Its header carries a "do not implement until…" note — re-read it before starting; the tenant-context half of the dependency is now satisfied. |
| 28 | [`activity-feed`](../phase-1/28-activity-feed/spec.md) | 7/0 | 01, 26, 27 | Append-only organization events over the mutations added by `26`/`27`. |

## Wave 6 — money and integrity (29–31)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 29 | [`stripe-billing-platform`](../phase-1/29-stripe-billing-platform/spec.md) | 2/49 | 01, 26 | Owns Stripe and the credit ledger for the whole product. Remaining: sandbox/Test-Clock certification and the Denmark canary. |
| 30 | [`pricing-and-billing`](../phase-1/30-pricing-and-billing/spec.md) | 0/3 | (superseded by 29) | Read-only record. |
| 31 | [`abuse-and-usage-integrity`](../phase-1/31-abuse-and-usage-integrity/spec.md) | 1/32 | 01, 26, 29 | Enforcement rollout closed out at "warn" by user decision. |

## Wave 7 — product surfaces on the platform (32–40)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 32 | [`unified-timeline`](../phase-1/32-unified-timeline/spec.md) | 0/13 | 20 | Non-AI core; its optional summary task plugs into `20`. Header says `pending` with 13/13 done. |
| 33 | [`smart-alerts`](../phase-1/33-smart-alerts/spec.md) | 1/13 | 20 | Leftover AI-digest wiring touches the reserved `src/shared/lib/email.ts`; task registered and inert. |
| 34 | [`rss-feeds`](../phase-1/34-rss-feeds/spec.md) | 0/7 | — | Real URL is `/api/feeds/{searchId}`, not the `.xml` path earlier drafts promised. |
| 35 | [`claimable-profiles`](../phase-1/35-claimable-profiles/spec.md) | 2/12 | — | The open trust boundary: the claim email proves mailbox access, not ownership of the indexed source identity. |
| 36 | [`portfolio-builder`](../phase-1/36-portfolio-builder/spec.md) | 5/8 | 35 | Composes verified claims (+ optional `23`/`32` artifacts) into an explicitly published surface. |
| 37 | [`work-sample`](../phase-1/37-work-sample/spec.md) | 1/8 | 20, 24 | Leftover needs a real `GITHUB_TOKEN` / `MINIMAX_API_KEY`; neither configured. |
| 38 | [`technical-sandbox`](../phase-1/38-technical-sandbox/spec.md) | 0/0 | (superseded by 37) | Never implement real-person roleplay. |
| 39 | [`team-synergy`](../phase-1/39-team-synergy/spec.md) | 1/6 | 20, 23, 24, 26 | Phase 5 carries its own "do not start" note. |
| 40 | [`ai-sourcing-sprints`](../phase-1/40-ai-sourcing-sprints/spec.md) | 1/22 | 01, 20, 21, 22, 26 | Phases 1–5 shipped and live-verified; Phase 6 has one dedicated item — see the plan header. |

## Wave 8 — heavy programs (41–43)

The three largest bodies of work. Each depends on the full foundation plus billing, which is
why they are last among the feature plans rather than first among the ambitious ones.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 41 | [`stealth-scraping`](../phase-1/41-stealth-scraping/spec.md) | 9/30 | 01, 03 | Directory name is legacy: the feature is **Public Profile Enrichment** and must never claim evasion. Code complete, `ENRICHMENT_ENABLED=false`; needs deploy-dark → 7-day canary → approval. Uses `task.md`/`implementation_plan.md` instead of the trio. |
| 42 | [`solutions-intelligence`](../phase-1/42-solutions-intelligence/spec.md) | 30/0 | 01, 20, 29, 41 | Blocked on `41` being live plus a 60-brief gold-set quality bar. Largest untouched plan. |
| 43 | [`calendar-scheduling-interview-intelligence`](../phase-1/43-calendar-scheduling-interview-intelligence/spec.md) | 9/69 | 01, 20, 29 | Was the biggest plan in the backlog; now 69 of 78 tasks are done. Remaining work is the sensitive tail: private documents, live transcription, retention, rollout. |

## Wave 9 — public surface and content (44–46)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 44 | [`public-landing-pages`](../phase-1/44-public-landing-pages/spec.md) | 0/13 | — | SEO surface largely live; **no public radars** (`public_radars` is not in `schema.ts`). Blocks `45` and `53`. |
| 45 | [`content-marketing`](../phase-1/45-content-marketing/spec.md) | 6/11 | 44 | |
| 46 | [`status-and-trust`](../phase-1/46-status-and-trust/spec.md) | 1/15 | — | Missing uptime *history* and incident subscriptions; the leftover is optional and touches a reserved file. |

## Wave 10 — release gates (47–52)

Audits are recurring gates, not one-time cleanups. They come last in the build order because
they gate a release, and they are numbered so a review pass hits them after everything they
measure.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 47 | [`audit-accessibility`](../phase-1/47-audit-accessibility/spec.md) | 0/14 | — | WCAG 2.2 AA gate. Header says `partially-implemented` with 14/14 done. |
| 48 | [`audit-performance-qa`](../phase-1/48-audit-performance-qa/spec.md) | 1/9 | 44 | Lighthouse/Playwright harness + CI quality gate. Unblocked 2026-07-27. |
| 49 | [`audit-visual-system`](../phase-1/49-audit-visual-system/spec.md) | 2/8 | 47, 48 | Needs new e2e infra and a production check. Unblocked 2026-07-27. |
| 50 | [`audit-conversion`](../phase-1/50-audit-conversion/spec.md) | 3/13 | 03, 44 | Waiting on ≥14 real days and 1,000 sessions with `CONVERSION_EVENTS_ENABLED=true`, then a rollout decision. |
| 51 | [`audit-trust`](../phase-1/51-audit-trust/spec.md) | 2/8 | 03, 30, 35, 48 | Only meaningful once a maintainer turns `PROFILE_REMOVAL_ENABLED` on. |
| 52 | [`exhaustive-local-e2e-design`](../phase-1/52-exhaustive-local-e2e-design/tasks.md) | 10/3 | 01, 26, 29 | Design waves 4+5 of the e2e suite; entirely additive. Only file is `tasks.md` — no `spec.md`/`plan.md`. New Playwright files now belong in `tests/e2e` after the 2026-07-27 test-layout unification. |

## Wave 11 — launch (53)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 53 | [`waitlist-launch`](../phase-1/53-waitlist-launch/spec.md) | 9/0 | 02, 03, 30, 44, 45, 46 | Manual go-to-market (Show HN, social, Search Console) — the founder's runbook, not code. The product keeps open signup and adds no artificial waitlist. |

## Divergences found while building this order (2026-07-28)

These are the reasons a review pass is worth doing at all. None of them is fixed by this
document; each is a claim to verify against `src/`.

**15 plans reported a non-closed status with zero open tasks. Seven are now resolved.**

Closed on 2026-07-28 after verifying each claim against `src/` — in every case the checklist was
right and the status line was stale, and in five of them `tasks.md` already said `implemented`
while `spec.md` and `plan.md` had been left behind:

- `04-project-hygiene` — the fabrication is gone: the estimator is `djb2`-seeded and deterministic,
  real signals come from `src/lib/github/repo-signals.ts` via
  `src/routes/api/builders/$builderId/hygiene.ts`, and the card labels the fallback on screen as
  "Estimated from profile signals — not real repo data".
- `08-gitlab-integration`, `09-codeberg-integration`, `13-stack-overflow-integration` — the declared
  gap was undocumented env vars. `GITLAB_TOKEN`, `CODEBERG_API_URL`, `CODEBERG_TOKEN` and
  `STACKOVERFLOW_API_KEY` are all in `.env.example`, and StackOverflow's quota is no longer silent
  (`warnIfQuotaLow` → `stackoverflow_quota_low`).
- `11-npm-registry-integration` — search migrated off `api.npms.io` to
  `registry.npmjs.org/-/v1/search` on 2026-07-25; the reality check still described the old
  dependency.
- `14-lobsters-integration` — every scoped task verified, including "no scraping dependency": no
  `cheerio`/`linkedom`/`jsdom` in `package.json`.
- `26-team-accounts` — the header said "no Team UI or organization runtime exists" while
  `OrganizationSwitcher.tsx`, `settings/team.tsx` and the whole `api/organizations/` surface
  (invitations, members, switch, transfer-ownership, deletion) were live. This one mattered beyond
  itself: seven plans declare a dependency on `26`, so a `pending` header there made half the
  backlog look blocked. Its `tasks.md` also used the status word `done`, which
  `conventions.md` does not define.

Still open, and worth the same treatment: `05-design-modernization`, `06-responsive-mobile-design`,
`23-ai-profile-enrichment`, `24-code-fingerprinting`, `32-unified-timeline`, `34-rss-feeds`,
`44-public-landing-pages`, `47-audit-accessibility`.

Two of those eight are the most suspicious of the set: `24-code-fingerprinting`'s header says "v2 AI
analysis of real repo code is pending" and `23-ai-profile-enrichment`'s says "claim-triggered
auto-refresh deferred" — yet neither has an unchecked box representing that gap. A deferred scope
with no open task is invisible work. A third is worth a look for the opposite reason:
`44-public-landing-pages` claims `public_radars` is not in `schema.ts`, but `db:audit-schema` lists
`public_radars` among its unclassified tables, so the table appears to exist now.

**3 plans claim a closed status while carrying open tasks:** `40-ai-sourcing-sprints` (1),
`41-stealth-scraping` (9), `19-indiehackers-integration` (2). All three are explained in their
headers (dedicated Phase 6 item, human-decision canary, optional follow-ups), so the counts are
honest — but the status word alone is misleading.

**3 plans break the file convention** in `conventions.md`: `52-exhaustive-local-e2e-design` has
only `tasks.md`; `41-stealth-scraping` uses `task.md` + `implementation_plan.md`;
`40-ai-sourcing-sprints` carries an extra `assets/` directory (benign).

**The 2026-07-27 queue snapshot has already drifted.** Today's counts differ materially:
`43-calendar-scheduling-interview-intelligence` is 9/69, not 47/32; `48-audit-performance-qa`
is 1/9, not 7/4; `49-audit-visual-system` is 2/8, not 3/7; `52-exhaustive-local-e2e-design` is
10/3, not 12/0. Treat any count in a dated snapshot as a starting hypothesis.

## Review protocol (plan vs implemented feature)

Walk the numbers in order. For each plan:

1. Read the header. Does `Depends on` still name a real prerequisite, and is that prerequisite
   actually satisfied at its own number?
2. Take each `[x]` task and open the file it names. A checked task whose file does not contain
   the described behavior is the finding — not the unchecked ones.
3. Take each `[ ]` task and decide which it is: real remaining work, work that shipped without
   being checked off, or a task waiting on a decision/credential/elapsed time. Only the first
   kind belongs in a queue.
4. Reconcile the status word with what you just read, and update the header in all three files.
5. For anything touching private data, re-check `security-policy.md`'s list: data class,
   non-owner runtime role, server-resolved tenant context, composite tenant integrity, RLS,
   tenant A/B tests. For anything touching AI, re-check `ai-policy.md`'s: task ID, tier policy,
   zod schema, cache TTL, plan gating, fallback.

## Invariant

Every plan's dependencies must carry a lower number than the plan itself — with the single
documented exception of `21`↔`22`. Verify after any renumbering:

```bash
pnpm plans:check-order
```
