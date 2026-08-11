# Phase 1 — canonical build order (01→54)

Every plan directory carries a two-digit prefix that is its position in this order. Since 2026-08-11
those directories live in **two** places: `plans/implemented/` for the 47 that are done and tested, and
`plans/phase-1/` for the 12 that are not (see [`../implemented/README.md`](../implemented/README.md)).
The split is about *state*, not about order — a plan's number never changes when it moves, and
`scripts/check-plan-order.mjs` reads the union of both directories so the contiguity and
dependencies-point-backward guarantees are exactly what they were. The number answers one question: **if BuilderHunt had to be built again from an empty
repository, in what sequence would these 53 plans be executed so that no plan is ever started
before something it depends on exists?**

The same number is the review order. Auditing plan-vs-reality top-to-bottom means you always
read a plan after the plans it builds on, so "this claims to be implemented" can be checked
against a foundation you have already verified rather than assumed.

**Snapshot: 2026-08-03.** 54 plans, 781 tasks, 723 done (93%), 58 open, **38 plans with zero open tasks**.

Regenerate with the one-liner in [`phase-1-queue.md`](./phase-1-queue.md) rather than trusting this line — it
is a snapshot, and every snapshot in this file has been wrong within a week of being written.

The jump from 152 open to 58 is one long execution session, not a redefinition: plan 53's API and browser
matrices, plans 51 and 52 closed, and three defects the matrices found fixed in production code. Two tasks were
*added* in the same session — an `/api` route-method sweep and a concurrent-invitation constraint — both from
findings, which is why the total moved 779 → 781 while the open count fell.

## Executable in order, 01 → 54

Phase 1 is meant to be walked top to bottom by an agent without stopping to ask anything. As of
2026-07-29 that holds, and here is what had to be true for it:

- **No plan carries a `blocked` status.** `28-shared-resources` and `29-activity-feed` did. All six of
  28's preconditions were verified met, and 29's only outstanding one is 28 itself — which is an order,
  not a hold.
- **No task says "do not start".** Four such holds were stale: 28's precondition list, 40's Phase 5
  (whose blocker `27-team-accounts` shipped 2026-07-22), 34's `email.ts` "reserved file" (a rule that
  belonged to one past session), and 16's "blocked on a vendor decision" (the task states the full
  replacement path; the paid-API question was about a different, unscoped integration).
- **No dependency points forward**, so walking the numbers satisfies every one. The single exception
  is the documented `22`↔`23` cycle, and both are closed, so nothing waits on it. This is why the
  legacy-column contraction moved from `01` to `30`: it cannot run until 30 retires `plans` and
  `plan_requests`, and an agent walking in order reached it 29 plans too early.
- **The five tasks a person must do carry `Operator:`** and are listed in
  [`operator-queue.md`](./operator-queue.md). The protocol is: skip, leave unchecked, report at the
  end. Never ask, never wait.

Seven further tasks left the phase entirely on 2026-07-29 — their definitions contained the launch —
and live in [`../phase-5/01-production-readiness-audit`](../phase-5/01-production-readiness-audit/spec.md).

**Seven tasks left this phase on 2026-07-29** for `plans/phase-5/01-production-readiness-audit`. They
were not unfinished work — their definitions contain the launch: a conversion baseline needs ≥14 days
of real traffic and ≥1,000 sessions, a canary needs seven days, and performance and visual baselines
have to be measured against a deployed release. Keeping them here meant this phase could never be
answered "done", which hid the difference between *work remaining* and *time remaining*. Phase 1's bar
is now reachable and honest: every piece of work done and verified in a green `pnpm ci:local`. Each
origin plan (`42`, `49`, `50`, `51`, `52`) carries a pointer instead of a checkbox. The jump from 748 to 787 is `03-postgres-18-upgrade` arriving from `phase-2` with 39
open tasks — the percentage fell without any work being undone. Regenerate the counts with the command in
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
`22-semantic-search` precedes `23-proactive-discovery`. This is the only place where a
`Depends on` header points forward instead of backward.

**Why `03-postgres-18-upgrade` sits at 03.** It declares `Depends on: nothing`, so nothing forces
its position — but it is not free to place either, because its own spec says it is "strictly ordered
against every other plan". Three facts fix it here:

1. It cannot go before `01`. The cutover has to *preserve* six non-owner LOGIN roles and
   `FORCE ROW LEVEL SECURITY` on 58 tables, and `01` is what creates them. There is nothing to
   carry across a major upgrade until that foundation exists.
2. It should not go before `02`. Phase 0 is a dump/restore rehearsal against a copy of a real pg16
   database, and a major-version cutover behind an unverified off-site backup is the one shape of
   this work that cannot be undone. `02`'s remaining task is exactly that backup.
3. It should not go later. Its own argument is that the cost grows with data size and with how many
   tenants are writing — and today nobody is billed, because `30-stripe-billing-platform` is not
   live. Every plan that ships first makes this one more expensive. Its Phase 4 is also what
   unlocks `NOT NULL ... NOT VALID` for expand/contract migrations, including the legacy-column
   contraction that is `01`'s last open task.

That last point is a soft loop, not a cycle: `01` does not depend on PG18, it merely gets a better
tool for its final migration if PG18 lands first. No `Depends on` header encodes it, so
`pnpm plans:check-order` stays quiet.

`31-pricing-and-billing` and `39-technical-sandbox` are `superseded`. They keep numbers because
they are still the decision record for why their scope moved (to `30-stripe-billing-platform`
and `38-work-sample`); they are read-only and nothing is executed from them.

## Wave 0 — foundation and truth (01–05)

Nothing else may be trusted until these are real. `01` gates almost the whole backlog; `05`
exists because the UI presented synthetic evidence as measured fact.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 01 | [`security-and-multitenancy`](../implemented/01-security-and-multitenancy/spec.md) | 0/19 | — | Blocks 7 plans directly. Canonical tenant cutover shipped 2026-07-27 (`organization_id` `NOT NULL` on all seven tenant-private tables, `drizzle/0081`). Only leftover: `TENANT_READ_MODE` still defaults to `legacy` and no contract migration drops the legacy columns. (Reality check 2026-07-31: was 1/18 — "Classify the 45 unclassified tables" is now `[x]`, done 2026-07-31 in the same phase-1 audit's fix pass.) |
| 02 | [`production-infrastructure`](../implemented/02-production-infrastructure/spec.md) | 3/16 | 01 | Backup cron, log rotation, and off-site copy need production SSH — not more code. (Reality check 2026-07-31: was 2/17; the log-rotation task's own text says "not executed" but its checkbox was `[x]` — recounted as `[~]` in tasks.md, which moves it into Open.) |
| 03 | [`postgres-18-upgrade`](../implemented/03-postgres-18-upgrade/spec.md) | 39/0 | — (ordered, see below) | Moved here from `phase-2` on 2026-07-28. Its own case for going early: the cutover cost is a function of data size and of how many tenants are writing, and today nobody is billed, so this is the cheapest this will ever be. Phases 0–4 contain zero PG18-only SQL — images, docs, rehearsal, cutover. Every image must be a `pgvector/pgvector:*` one. |
| 04 | [`legal-and-compliance`](../implemented/04-legal-and-compliance/spec.md) | 0/17 | — | Hard deletion + external-AI disclosure. Must precede any production MiniMax traffic (`21`). |
| 05 | [`project-hygiene`](../implemented/05-project-hygiene/spec.md) | 0/8 | — | **Closed 2026-07-28.** Fabricated `Math.random()` evidence removed; real GitHub signals plus an on-screen "estimated" label. |

## Wave 1 — shell and design foundation (06–08)

These touch the components every later surface renders through. Their own headers say to land
them before new UI is stacked on top.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 06 | [`design-modernization`](../implemented/06-design-modernization/spec.md) | 0/17 | — | Unfinished dark→warm-light migration; feeds all five audits (`48`–`52`). |
| 07 | [`responsive-mobile-design`](../implemented/07-responsive-mobile-design/spec.md) | 0/10 | — | Overlaps `50-audit-visual-system`'s unchecked "dashboard shell" task on the same file. |
| 08 | [`onboarding-flow`](../implemented/08-onboarding-flow/spec.md) | 0/13 | — | `implemented`; the one plan whose status has never been in question. |

## Wave 2 — source connectors (09–20)

All independent of each other and of everything above except the tenant model. Ordered git
hosts → package registries → community platforms → credential/decision-gated.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 09 | [`gitlab-integration`](../implemented/09-gitlab-integration/spec.md) | 0/9 | — | **Closed 2026-07-28**: `GITLAB_TOKEN` is documented in `.env.example`. |
| 10 | [`codeberg-integration`](../implemented/10-codeberg-integration/spec.md) | 0/8 | — | **Closed 2026-07-28**: both Codeberg env vars documented. |
| 11 | [`sourcehut-integration`](../phase-1/11-sourcehut-integration/spec.md) | 1/7 | — | Remaining item is explicitly optional. |
| 12 | [`npm-registry-integration`](../implemented/12-npm-registry-integration/spec.md) | 0/8 | — | **Closed 2026-07-28**: search runs on `registry.npmjs.org`, not npms.io. |
| 13 | [`huggingface-integration`](../implemented/13-huggingface-integration/spec.md) | 1/7 | — | Remaining item is explicitly optional. |
| 14 | [`stack-overflow-integration`](../implemented/14-stack-overflow-integration/spec.md) | 0/10 | — | **Closed 2026-07-28**: env documented and quota exhaustion logged. |
| 15 | [`lobsters-integration`](../implemented/15-lobsters-integration/spec.md) | 0/6 | — | **Closed 2026-07-28**: JSON-only by decision; scraping enrichment is a closed non-goal. |
| 16 | [`hashnode-integration`](../phase-1/16-hashnode-integration/spec.md) | 1/8 | — | Paused on a paid-API vendor decision (decided: paused). |
| 17 | [`bluesky-integration`](../implemented/17-bluesky-integration/spec.md) | 0/6 | — | Ships without credentials. |
| 18 | [`producthunt-integration`](../implemented/18-producthunt-integration/spec.md) | 0/6 | — | Wired but dormant until a token is provisioned. |
| 19 | [`devpost-integration`](../implemented/19-devpost-integration/spec.md) | 0/3 | — | Implemented, dark by default. |
| 20 | [`indiehackers-integration`](../phase-1/20-indiehackers-integration/spec.md) | 2/1 | — | Closed by decision; the two open boxes are optional follow-ups that inflate every count. |

## Wave 3 — the one AI platform (21)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 21 | [`ai-expansion`](../implemented/21-ai-expansion/spec.md) | 0/19 | 01 | The only provider integration layer: task registry, Chrome capability UX, MiniMax client, structured-output validation, cache, budgets, kill switches. No feature-specific AI endpoint may exist before this. |

## Wave 4 — first AI value and search core (22–26)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 22 | [`semantic-search`](../implemented/22-semantic-search/spec.md) | 0/16 | 01, 21 (+23, cycle) | Embeddings, pgvector, global external-profile index, cold-start fallback to federated search. |
| 23 | [`proactive-discovery`](../implemented/23-proactive-discovery/spec.md) | 0/10 | 21, 22 | Populates the global index via an idempotent HTTP-cron worker. |
| 24 | [`ai-profile-enrichment`](../implemented/24-ai-profile-enrichment/spec.md) | 0/8 | 21 | Persona Card shipped for tracked builders; header says claim-triggered auto-refresh was deferred, yet zero tasks are open. |
| 25 | [`code-fingerprinting`](../implemented/25-code-fingerprinting/spec.md) | 0/11 | 21 | Header says v1 heuristic shipped and v2 AI analysis pending, yet zero tasks are open. |
| 26 | [`outreach-generator`](../implemented/26-outreach-generator/spec.md) | 0/9 | 21 | v1 rule-based + v2 AI both shipped; rule-based stays the final fallback. |

## Wave 5 — organizations and shared ownership (27–29)

`01` supplies the organization model, RLS and entitlements. These three add the UX and the
mutations on top; none of them may create a competing organization model.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 27 | [`team-accounts`](../implemented/27-team-accounts/spec.md) | 0/9 | 01 | **Closed 2026-07-28.** Switcher, Team settings and the full `api/organizations/` surface verified live. One known follow-up stays out of scope: a hook-ordering race can leave a fresh sign-up's session with `active_organization_id: null`. |
| 28 | [`shared-resources`](../implemented/28-shared-resources/spec.md) | 10/0 | 01, 27 | Its header carries a "do not implement until…" note — re-read it before starting; the tenant-context half of the dependency is now satisfied. |
| 29 | [`activity-feed`](../implemented/29-activity-feed/spec.md) | 7/0 | 01, 27, 28 | Append-only organization events over the mutations added by `27`/`28`. |

## Wave 6 — money and integrity (30–32)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 30 | [`stripe-billing-platform`](../implemented/30-stripe-billing-platform/spec.md) | 2/49 | 01, 27 | Owns Stripe and the credit ledger for the whole product. Remaining: sandbox/Test-Clock certification and the Denmark canary. |
| 31 | [`pricing-and-billing`](../phase-1/31-pricing-and-billing/spec.md) | 0/3 | (superseded by 30) | Read-only record. |
| 32 | [`abuse-and-usage-integrity`](../implemented/32-abuse-and-usage-integrity/spec.md) | 1/32 | 01, 27, 30 | Enforcement rollout closed out at "warn" by user decision. |

## Wave 7 — product surfaces on the platform (33–41)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 33 | [`unified-timeline`](../implemented/33-unified-timeline/spec.md) | 0/13 | 21 | Non-AI core; its optional summary task plugs into `21`. Header says `pending` with 13/13 done. |
| 34 | [`smart-alerts`](../implemented/34-smart-alerts/spec.md) | 1/13 | 21 | Leftover AI-digest wiring touches the reserved `src/shared/lib/email.ts`; task registered and inert. |
| 35 | [`rss-feeds`](../implemented/35-rss-feeds/spec.md) | 0/7 | — | Real URL is `/api/feeds/{searchId}`, not the `.xml` path earlier drafts promised. |
| 36 | [`claimable-profiles`](../implemented/36-claimable-profiles/spec.md) | 2/12 | — | The open trust boundary: the claim email proves mailbox access, not ownership of the indexed source identity. |
| 37 | [`portfolio-builder`](../implemented/37-portfolio-builder/spec.md) | 5/8 | 36 | Composes verified claims (+ optional `24`/`33` artifacts) into an explicitly published surface. |
| 38 | [`work-sample`](../implemented/38-work-sample/spec.md) | 1/8 | 21, 25 | Leftover needs a real `GITHUB_TOKEN` / `MINIMAX_API_KEY`; neither configured. |
| 39 | [`technical-sandbox`](../phase-1/39-technical-sandbox/spec.md) | 0/0 | (superseded by 38) | Never implement real-person roleplay. |
| 40 | [`team-synergy`](../implemented/40-team-synergy/spec.md) | 1/6 | 21, 24, 25, 27 | Phase 5 carries its own "do not start" note. |
| 41 | [`ai-sourcing-sprints`](../implemented/41-ai-sourcing-sprints/spec.md) | 1/22 | 01, 21, 22, 23, 27 | Phases 1–5 shipped and live-verified; Phase 6 has one dedicated item — see the plan header. |

## Wave 8 — heavy programs (42–44)

The three largest bodies of work. Each depends on the full foundation plus billing, which is
why they are last among the feature plans rather than first among the ambitious ones.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 42 | [`stealth-scraping`](../implemented/42-stealth-scraping/spec.md) | 3/30 | 01, 04 | Directory name is legacy: the feature is **Public Profile Enrichment** and must never claim evasion. Code complete, `ENRICHMENT_ENABLED=false`; needs deploy-dark → 7-day canary → approval. Uses `task.md`/`implementation_plan.md` instead of the trio. (Reality check 2026-07-31: recounted `task.md`'s checkboxes — was 9/30.) |
| 43 | [`solutions-intelligence`](../implemented/43-solutions-intelligence/spec.md) | 27/3 | 01, 21, 30, 42 | Blocked on `42` being live plus a 60-brief gold-set quality bar. Still `implementation authorized: no`. (Reality check 2026-07-31: 3 Phase-1 prep tasks are real, shipped work with cited files — `src/shared/lib/solutions/contracts.ts`, `src/shared/lib/solutions/config.ts`, and the non-provider product shell `src/modules/solutions/*` + `src/routes/_dashboard/solutions/index.tsx` — though tasks.md's own checkboxes for them stay unchecked pending formal authorization. Was 30/0, "Largest untouched plan", which undercounted this.) |
| 44 | [`calendar-scheduling-interview-intelligence`](../implemented/44-calendar-scheduling-interview-intelligence/spec.md) | 9/69 | 01, 21, 30 | Was the biggest plan in the backlog; now 69 of 78 tasks are done. Remaining work is the sensitive tail: private documents, live transcription, retention, rollout. |

## Wave 9 — public surface and content (45–47)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 45 | [`public-landing-pages`](../implemented/45-public-landing-pages/spec.md) | 0/14 | — | SEO surface largely live; **public radars are built** (`publicRadars` in `schema.ts`, table `public_radars`, `drizzle/0054`). Blocks `46` and `54`. (Reality check 2026-07-31: was 0/13, "no public radars — not in schema.ts", both stale.) |
| 46 | [`content-marketing`](../implemented/46-content-marketing/spec.md) | 6/11 | 45 | |
| 47 | [`status-and-trust`](../implemented/47-status-and-trust/spec.md) | 1/15 | — | Missing uptime *history* and incident subscriptions; the leftover is optional and touches a reserved file. |

## Wave 10 — release gates (48–53)

Audits are recurring gates, not one-time cleanups. They come last in the build order because
they gate a release, and they are numbered so a review pass hits them after everything they
measure.

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 48 | [`audit-accessibility`](../implemented/48-audit-accessibility/spec.md) | 0/14 | — | WCAG 2.2 AA gate. Header says `partially-implemented` with 14/14 done. |
| 49 | [`audit-performance-qa`](../implemented/49-audit-performance-qa/spec.md) | 1/9 | 45 | Lighthouse/Playwright harness + CI quality gate. Unblocked 2026-07-27. |
| 50 | [`audit-visual-system`](../implemented/50-audit-visual-system/spec.md) | 2/8 | 48, 49 | Needs new e2e infra and a production check. Unblocked 2026-07-27. |
| 51 | [`audit-conversion`](../implemented/51-audit-conversion/spec.md) | 3/13 | 04, 45 | Waiting on ≥14 real days and 1,000 sessions with `CONVERSION_EVENTS_ENABLED=true`, then a rollout decision. |
| 52 | [`audit-trust`](../implemented/52-audit-trust/spec.md) | 2/8 | 04, 31, 36, 49 | Only meaningful once a maintainer turns `PROFILE_REMOVAL_ENABLED` on. |
| 53 | [`exhaustive-local-e2e-design`](../implemented/53-exhaustive-local-e2e-design/tasks.md) | 10/3 | 01, 27, 30 | Design waves 4+5 of the e2e suite; entirely additive. Only file is `tasks.md` — no `spec.md`/`plan.md`. New Playwright files now belong in `tests/e2e` after the 2026-07-27 test-layout unification. |

## Wave 11 — launch (54)

| # | Plan | Open/Done | Deps | Note |
|--:|------|----------:|------|------|
| 54 | [`waitlist-launch`](../phase-1/54-waitlist-launch/spec.md) | 9/0 | 02, 04, 31, 45, 46, 47 | Manual go-to-market (Show HN, social, Search Console) — the founder's runbook, not code. The product keeps open signup and adds no artificial waitlist. |

## Divergences found while building this order (2026-07-28)

These are the reasons a review pass is worth doing at all. None of them is fixed by this
document; each is a claim to verify against `src/`.

**15 plans reported a non-closed status with zero open tasks. Seven are now resolved.**

Closed on 2026-07-28 after verifying each claim against `src/` — in every case the checklist was
right and the status line was stale, and in five of them `tasks.md` already said `implemented`
while `spec.md` and `plan.md` had been left behind:

- `05-project-hygiene` — the fabrication is gone: the estimator is `djb2`-seeded and deterministic,
  real signals come from `src/lib/github/repo-signals.ts` via
  `src/routes/api/builders/$builderId/hygiene.ts`, and the card labels the fallback on screen as
  "Estimated from profile signals — not real repo data".
- `09-gitlab-integration`, `10-codeberg-integration`, `14-stack-overflow-integration` — the declared
  gap was undocumented env vars. `GITLAB_TOKEN`, `CODEBERG_API_URL`, `CODEBERG_TOKEN` and
  `STACKOVERFLOW_API_KEY` are all in `.env.example`, and StackOverflow's quota is no longer silent
  (`warnIfQuotaLow` → `stackoverflow_quota_low`).
- `12-npm-registry-integration` — search migrated off `api.npms.io` to
  `registry.npmjs.org/-/v1/search` on 2026-07-25; the reality check still described the old
  dependency.
- `15-lobsters-integration` — every scoped task verified, including "no scraping dependency": no
  `cheerio`/`linkedom`/`jsdom` in `package.json`.
- `27-team-accounts` — the header said "no Team UI or organization runtime exists" while
  `OrganizationSwitcher.tsx`, `settings/team.tsx` and the whole `api/organizations/` surface
  (invitations, members, switch, transfer-ownership, deletion) were live. This one mattered beyond
  itself: seven plans declare a dependency on `27`, so a `pending` header there made half the
  backlog look blocked. Its `tasks.md` also used the status word `done`, which
  `conventions.md` does not define.

Still open, and worth the same treatment: `06-design-modernization`, `07-responsive-mobile-design`,
`24-ai-profile-enrichment`, `25-code-fingerprinting`, `33-unified-timeline`, `35-rss-feeds`,
`45-public-landing-pages`, `48-audit-accessibility`.

Two of those eight are the most suspicious of the set: `25-code-fingerprinting`'s header says "v2 AI
analysis of real repo code is pending" and `24-ai-profile-enrichment`'s says "claim-triggered
auto-refresh deferred" — yet neither has an unchecked box representing that gap. A deferred scope
with no open task is invisible work.

**Reality check (2026-07-31)**: `24-ai-profile-enrichment` and `45-public-landing-pages` are now
corrected at the source (`tasks.md`/`plan.md`/`spec.md` for `24`; `spec.md` and this file's `45`
row above for `45`) — Phase 3 shipped 2026-07-25, and `public_radars` genuinely exists in
`schema.ts`. `25-code-fingerprinting` was not investigated in this pass.

**3 plans claim a closed status while carrying open tasks:** `41-ai-sourcing-sprints` (1),
`42-stealth-scraping` (3), `20-indiehackers-integration` (2). All three are explained in their
headers (dedicated Phase 6 item, human-decision canary, optional follow-ups), so the counts are
honest — but the status word alone is misleading.

**3 plans break the file convention** in `conventions.md`: `53-exhaustive-local-e2e-design` has
only `tasks.md`; `42-stealth-scraping` uses `task.md` + `implementation_plan.md`;
`41-ai-sourcing-sprints` carries an extra `assets/` directory (benign).

**The 2026-07-27 queue snapshot has already drifted.** Today's counts differ materially:
`44-calendar-scheduling-interview-intelligence` is 9/69, not 47/32; `49-audit-performance-qa`
is 1/9, not 7/4; `50-audit-visual-system` is 2/8, not 3/7; `53-exhaustive-local-e2e-design` is
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
documented exception of `22`↔`23`. Verify after any renumbering:

```bash
pnpm plans:check-order
```
