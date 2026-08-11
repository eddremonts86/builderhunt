# BuilderHunt implementation roadmap

This directory is the implementation backlog for BuilderHunt. It contains 54 plan
records plus the shared planning policy in [`_meta/`](./_meta/). Each plan is a trio:
`spec.md` defines the outcome, `plan.md` defines the delivery sequence, and `tasks.md`
is the executable checklist.

[`phase-5/`](./phase-5/) is the MVP/Beta-to-production gate: it holds only the checks that cannot be
performed before the product has been deployed and has run for a while. A task belongs there when no
amount of engineering can close it sooner — it needs production to exist, clock time to pass, or a
person to decide. "Hard" is not the criterion.

> **Phase 1 reached zero open tasks on 2026-08-05.** The 21 that were still listed that morning all moved
> to `phase-5/`, applying the rule above to its conclusion: the product launches when phase-5 finishes, so
> legal reviews, go-to-market, soak windows and production sign-offs were never build-phase work. Phase 5
> now has three plans — production evidence and clocks, signatures and prices, and the launch — and each
> moved item left a prose pointer in its phase-1 plan rather than a checkbox. **A session looking for
> phase-1 code should find none; start from `phase-2/`.**

Every directory in [`phase-1/`](./phase-1/) is prefixed with its position in the canonical
build order, `01`–`54`. That number is the answer to "in what sequence would these plans be
built from an empty repository, so no plan starts before its dependencies exist" — and it is
also the order to walk when auditing plan-vs-reality.

## Where finished plans live

`plans/implemented/` holds the 47 phase-1 plans that are **done and tested** — every task closed, all
three files saying `implemented`, and `pnpm ci:local` green. See
[`implemented/README.md`](./implemented/README.md) for the entry criteria and for the twelve plans that
deliberately stayed in `plans/phase-1/`.

The two-digit prefixes did not change: the number is a plan's position in the canonical build order, not
its address. `scripts/check-plan-order.mjs` reads both directories as one corpus and still reports 59
plans numbered 01-59.

## Read this first

1. [`_meta/operator-queue.md`](./_meta/operator-queue.md) — read this first if you are an agent
   about to execute phase-1. Five tasks need a person (SSH, a €4/month subscription, two API keys,
   a legal signature). Skip them, leave them unchecked, report them at the end. Nothing else in
   phase-1 should make you stop and ask.
2. [`_meta/phase-1-order.md`](./_meta/phase-1-order.md) is the complete numbered index:
   all 54 plans, their dependencies as numbers, live task counts, and the divergences
   between what a plan's status claims and what its checklist shows. It is the only index
   here that covers every plan on disk — the categorized sections further down this file
   predate `calendar-scheduling-interview-intelligence`, `exhaustive-local-e2e-design`, and
   `solutions-intelligence` and still omit them.
3. [`_meta/app-reality.md`](./_meta/app-reality.md) is the source of truth for what is
   already shipped and which architectural constraints exist.
4. [`_meta/security-policy.md`](./_meta/security-policy.md) is binding for every plan that reads,
   persists, shares, exports, deletes, or sends private data.
5. [`_meta/ai-policy.md`](./_meta/ai-policy.md) is binding for every AI feature:
   Chrome built-in AI is the local-first default; MiniMax M3 is server-side for
   persisted, shared, background, embedding, and fallback work.
6. [`_meta/conventions.md`](./_meta/conventions.md) defines when a plan is ready for
   implementation.
7. Execute a plan's `tasks.md` from top to bottom. Re-check its dependency headers
   immediately before starting because statuses can change independently.

Status means:

- `implemented`: verified code already delivers the full scoped outcome.
- `partially-implemented`: useful code is live, and unchecked tasks are the honest gap.
- `pending`: implementation-ready, but no scoped production implementation exists.
- `blocked`: the plan is complete as a decision record, but implementation must wait
  for the dependency or external decision named in its spec.
- `superseded`: intentionally closed; its valid scope moved to another plan.

## Recommended build order

The order below optimizes for early product value, shared foundations, low migration
risk, and the smallest number of parallel schema changes. Plans within one wave may run
in parallel unless an explicit dependency says otherwise.

### Wave 0 — close production and truth gaps

Ship the small, already-understood gaps before adding AI infrastructure:

- [`security-and-multitenancy`](implemented/01-security-and-multitenancy/spec.md): normalize global/public,
  account-subject, tenant-private, and operational data; adopt Better Auth organizations; separate
  runtime/migration database roles; add transaction-scoped tenant context, composite integrity,
  RLS, migration rehearsal, and tenant A/B gates. Its expand/backfill work may run alongside the
  non-schema truth fixes below, but RLS enforcement precedes every later private-data expansion.
- [`project-hygiene`](implemented/05-project-hygiene/spec.md): remove fabricated `Math.random()`
  evidence and use real repository signals.
- [`hashnode-integration`](./phase-1/16-hashnode-integration/spec.md): migrate the dead legacy API.
- [`gitlab-integration`](implemented/09-gitlab-integration/spec.md),
  [`codeberg-integration`](implemented/10-codeberg-integration/spec.md),
  [`huggingface-integration`](implemented/13-huggingface-integration/spec.md),
  [`sourcehut-integration`](./phase-1/11-sourcehut-integration/spec.md), and
  [`stack-overflow-integration`](implemented/14-stack-overflow-integration/spec.md): close env,
  observability, and quota-reporting gaps.
- [`production-infrastructure`](implemented/02-production-infrastructure/spec.md): backups,
  monitoring, cron authentication, and operational prerequisites for workers and AI.
- [`legal-and-compliance`](implemented/04-legal-and-compliance/spec.md): finish hard deletion and
  disclose external AI processing before MiniMax receives production traffic.

Exit gate: no UI presents synthetic evidence as measured fact; backup restore and worker
authentication have runtime evidence; the privacy surface covers MiniMax; the web runtime uses a
non-owner role and tenant A/B plus direct-SQL RLS tests pass for every migrated private table.

### Wave 1 — shared AI platform

- [`ai-expansion`](implemented/21-ai-expansion/spec.md) is the only provider integration layer.
- Build its task registry, Chrome capability/download UX, MiniMax server client,
  structured-output validation, Redis cache, budgets, kill switches, and audit-safe
  telemetry before any feature-specific AI endpoint.

Exit gate: one local-first task and one server-only task pass contract, fallback,
rate-limit, privacy, and provider-failure tests in a production-like runtime.

### Wave 2 — first AI value

These features reuse the shared platform and can be delivered independently:

- [`outreach-generator`](implemented/26-outreach-generator/spec.md): lowest-risk interactive value;
  keep the shipped rule-based generator as the final fallback.
- [`ai-profile-enrichment`](implemented/24-ai-profile-enrichment/spec.md): persisted MiniMax persona
  cards with provenance and a 30-day cache.
- [`code-fingerprinting`](implemented/25-code-fingerprinting/spec.md): real repository evidence,
  persisted v2 artifacts, and the shipped heuristic v1 as fallback.
- [`semantic-search`](implemented/22-semantic-search/spec.md): configured embeddings, pgvector, a global
  external-profile index, and cold-start fallback to federated search.

Exit gate: each task is plan-gated, schema-validated, budgeted, kill-switchable, and
usable when Chrome AI or MiniMax is unavailable according to its degradation ladder.

### Wave 3 — discovery and source coverage

- [`bluesky-integration`](implemented/17-bluesky-integration/spec.md) can ship without credentials.
- [`producthunt-integration`](implemented/18-producthunt-integration/spec.md) is token-gated.
- [`proactive-discovery`](implemented/23-proactive-discovery/spec.md) follows semantic search and
  populates the global index using an idempotent HTTP-cron worker.
- [`unified-timeline`](implemented/33-unified-timeline/spec.md) is non-AI core functionality; its
  optional summary task plugs into the AI platform.
- Keep [`devpost-integration`](implemented/19-devpost-integration/spec.md) and
  [`indiehackers-integration`](./phase-1/20-indiehackers-integration/spec.md) blocked until their
  explicit acquisition-policy decisions are resolved. Do not add brittle scraping to
  the live search request path.

### Wave 4 — teams and shared ownership

- [`security-and-multitenancy`](implemented/01-security-and-multitenancy/spec.md) supplies organizations,
  multi-membership, active tenant context, invitations, RLS, and organization entitlements.
- [`team-accounts`](implemented/27-team-accounts/spec.md) then supplies the Team settings/switcher/seat UX over
  that foundation; it does not create a competing organization model.
- [`shared-resources`](implemented/28-shared-resources/spec.md) second: shared searches and builder
  lists against the organization authorization boundary.
- [`activity-feed`](implemented/29-activity-feed/spec.md) last: append-only organization events over
  the mutations introduced by the first two plans.

Exit gate: cross-organization isolation, invitation lifecycle, owner-deletion guards,
seat limits, and audit-event redaction all pass integration tests.

### Wave 5 — advanced AI workflows

- [`work-sample`](implemented/38-work-sample/spec.md) and
  [`team-synergy`](implemented/40-team-synergy/spec.md) provide the Team-tier analysis promises.
- [`ai-sourcing-sprints`](implemented/41-ai-sourcing-sprints/spec.md) composes federated search, the
  AI task registry, tracking, semantic-index write-through, and the worker pattern.
- [`portfolio-builder`](implemented/37-portfolio-builder/spec.md) composes verified claims and
  optional enrichment/timeline artifacts into an explicitly published surface.
- [`technical-sandbox`](./phase-1/39-technical-sandbox/spec.md) stays superseded by work-sample;
  never implement real-person roleplay.

### Wave 6 — launch and continuous quality

- Complete [`pricing-and-billing`](./phase-1/31-pricing-and-billing/spec.md),
  [`public-landing-pages`](implemented/45-public-landing-pages/spec.md),
  [`content-marketing`](implemented/46-content-marketing/spec.md), and
  [`status-and-trust`](implemented/47-status-and-trust/spec.md).
- Run [`waitlist-launch`](./phase-1/54-waitlist-launch/spec.md) as the launch checklist; the product
  keeps open signup and does not add an artificial waitlist.
- Apply all five audits as release gates, not as a one-time cleanup:
  [`audit-accessibility`](implemented/48-audit-accessibility/spec.md),
  [`audit-conversion`](./phase-1/51-audit-conversion/spec.md),
  [`audit-performance-qa`](./phase-1/49-audit-performance-qa/spec.md),
  [`audit-trust`](implemented/52-audit-trust/spec.md), and
  [`audit-visual-system`](implemented/50-audit-visual-system/spec.md).

[`onboarding-flow`](implemented/08-onboarding-flow/spec.md) is already implemented.
[`rss-feeds`](implemented/35-rss-feeds/spec.md), [`smart-alerts`](implemented/34-smart-alerts/spec.md), and
[`claimable-profiles`](implemented/36-claimable-profiles/spec.md) should close their remaining gaps in
the earliest wave where their touched surface is already being changed.

## Dependency graph

Solid arrows are hard sequencing dependencies. Dashed arrows are optional enhancements
or reuse paths and must not prevent the destination from working independently.

```mermaid
flowchart LR
  SECURITY["Security and multi-tenancy"] --> INFRA["Production infrastructure"]
  SECURITY --> TEAM["Team accounts"]
  SECURITY --> AIP["AI platform"]
  SECURITY --> SEMANTIC["Semantic search"]
  SECURITY --> SPRINTS["AI sourcing sprints"]
  INFRA["Production infrastructure"] -. "production rollout" .-> AIP["AI platform"]
  LEGAL["Legal and compliance"] -. "production MiniMax disclosure" .-> AIP

  AIP --> OUTREACH["Outreach v2"]
  AIP --> ENRICH["Profile enrichment"]
  AIP --> FINGER["Code fingerprinting v2"]
  AIP --> SEMANTIC["Semantic search"]
  AIP --> SAMPLE["Work-sample analysis"]
  AIP --> SYNERGY["Team synergy"]
  AIP --> SPRINTS["AI sourcing sprints"]

  SEMANTIC --> DISCOVERY["Proactive discovery"]
  SEMANTIC -. "index write-through" .-> SPRINTS
  FINGER -. "shared GitHub fetcher" .-> SAMPLE
  FINGER -. "stronger evidence" .-> SYNERGY
  ENRICH -. "stronger evidence" .-> SYNERGY

  TEAM --> SHARED["Shared resources"]
  TEAM --> FEED["Activity feed"]
  SHARED -. "shared-resource events" .-> FEED
  TEAM -. "future shared sprints" .-> SPRINTS

  CLAIMS["Claimable profiles"] --> PORTFOLIO["Portfolio builder"]
  ENRICH -. "optional persona" .-> PORTFOLIO
  TIMELINE["Unified timeline"] -. "optional activity" .-> PORTFOLIO

  INFRA --> LAUNCH["Launch checklist"]
  LEGAL --> LAUNCH
  PRICING["Pricing and billing"] --> LAUNCH
  LANDING["Public landing pages"] --> CONTENT["Content marketing"]
  LANDING --> LAUNCH
  CONTENT --> LAUNCH
  TRUST["Status and trust"] --> LAUNCH
```

## Portfolio of plans

### Foundations and business

- [`security-and-multitenancy`](implemented/01-security-and-multitenancy/spec.md)
- [`abuse-and-usage-integrity`](implemented/32-abuse-and-usage-integrity/spec.md)
- [`production-infrastructure`](implemented/02-production-infrastructure/spec.md)
- [`postgres-18-upgrade`](implemented/03-postgres-18-upgrade/spec.md) — moved here from `phase-2`
  on 2026-07-28; see [`_meta/phase-1-order.md`](./_meta/phase-1-order.md) for why it sits at 03
- [`pricing-and-billing`](./phase-1/31-pricing-and-billing/spec.md)
- [`legal-and-compliance`](implemented/04-legal-and-compliance/spec.md)
- [`status-and-trust`](implemented/47-status-and-trust/spec.md)
- [`public-landing-pages`](implemented/45-public-landing-pages/spec.md)
- [`content-marketing`](implemented/46-content-marketing/spec.md)
- [`waitlist-launch`](./phase-1/54-waitlist-launch/spec.md)
- [`onboarding-flow`](implemented/08-onboarding-flow/spec.md)

### AI and analysis

- [`ai-expansion`](implemented/21-ai-expansion/spec.md)
- [`semantic-search`](implemented/22-semantic-search/spec.md)
- [`ai-profile-enrichment`](implemented/24-ai-profile-enrichment/spec.md)
- [`outreach-generator`](implemented/26-outreach-generator/spec.md)
- [`code-fingerprinting`](implemented/25-code-fingerprinting/spec.md)
- [`project-hygiene`](implemented/05-project-hygiene/spec.md)
- [`work-sample`](implemented/38-work-sample/spec.md)
- [`team-synergy`](implemented/40-team-synergy/spec.md)
- [`technical-sandbox`](./phase-1/39-technical-sandbox/spec.md) (superseded)

### Orchestration and publishing

- [`ai-sourcing-sprints`](implemented/41-ai-sourcing-sprints/spec.md)
- [`proactive-discovery`](implemented/23-proactive-discovery/spec.md)
- [`unified-timeline`](implemented/33-unified-timeline/spec.md)
- [`portfolio-builder`](implemented/37-portfolio-builder/spec.md)
- [`smart-alerts`](implemented/34-smart-alerts/spec.md)
- [`claimable-profiles`](implemented/36-claimable-profiles/spec.md)
- [`rss-feeds`](implemented/35-rss-feeds/spec.md)

### Teams

- [`team-accounts`](implemented/27-team-accounts/spec.md)
- [`shared-resources`](implemented/28-shared-resources/spec.md)
- [`activity-feed`](implemented/29-activity-feed/spec.md)

### Sources

- [`bluesky-integration`](implemented/17-bluesky-integration/spec.md)
- [`producthunt-integration`](implemented/18-producthunt-integration/spec.md)
- [`devpost-integration`](implemented/19-devpost-integration/spec.md) (blocked)
- [`indiehackers-integration`](./phase-1/20-indiehackers-integration/spec.md) (blocked)
- [`gitlab-integration`](implemented/09-gitlab-integration/spec.md)
- [`codeberg-integration`](implemented/10-codeberg-integration/spec.md)
- [`sourcehut-integration`](./phase-1/11-sourcehut-integration/spec.md)
- [`hashnode-integration`](./phase-1/16-hashnode-integration/spec.md)
- [`huggingface-integration`](implemented/13-huggingface-integration/spec.md)
- [`lobsters-integration`](implemented/15-lobsters-integration/spec.md)
- [`npm-registry-integration`](implemented/12-npm-registry-integration/spec.md)
- [`stack-overflow-integration`](implemented/14-stack-overflow-integration/spec.md)

### Release audits

- [`design-modernization`](implemented/06-design-modernization/spec.md)
- [`audit-accessibility`](implemented/48-audit-accessibility/spec.md)
- [`audit-conversion`](./phase-1/51-audit-conversion/spec.md)
- [`audit-performance-qa`](./phase-1/49-audit-performance-qa/spec.md)
- [`audit-trust`](implemented/52-audit-trust/spec.md)
- [`audit-visual-system`](implemented/50-audit-visual-system/spec.md)
- [`responsive-mobile-design`](./phase-1/07-responsive-mobile-design/spec.md) — overlaps
  `audit-visual-system`'s unchecked "dashboard shell" task; see that plan's spec.md for the
  relationship

## Global completion gate

Before a plan is marked `implemented`:

1. Every checked task points to code that exists; every unchecked task names exact files
   and a verification command.
2. Database migrations are forward-only and have a tested rollback or compatibility path.
3. `_meta/security-policy.md` is satisfied: data classification, non-owner runtime roles,
   server-resolved tenant context, composite tenant integrity, RLS, tenant A/B API and direct-SQL
   tests, migration rehearsal, and restore evidence exist for every affected private surface.
4. Authorization tests cover owner, organization member, non-member, and admin boundaries
   for every affected route.
5. AI tasks satisfy `_meta/ai-policy.md`, including Chrome/MiniMax fallback behavior,
   zod validation, budgets, privacy, prompt-injection defense, and kill switches.
6. Build, lint, type-check, tests, and the plan-specific runtime smoke test pass.
7. Production-facing features include observability, rollout, and rollback evidence.
8. The plan header and this roadmap are updated to match the verified runtime state.
