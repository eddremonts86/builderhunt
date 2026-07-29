# Plan Conventions — How Every Plan Must Be Written

Applies to every directory in `plans/`. A plan is "100% implementation-ready" only when it
follows this document. Written 2026-07-19 during the full plan-reconciliation pass.

## Directory name

A `plans/phase-1/` directory is named `NN-slug`, where `NN` is its position in the canonical
build order recorded in [`phase-1-order.md`](./phase-1-order.md). A new plan takes the number
of the earliest position whose dependencies it satisfies, and every existing plan from that
position onward shifts up — renumbering means `git mv` plus rewriting the `../NN-slug/` links
that point at each moved directory. `pnpm plans:check-order` fails on an unnumbered directory,
a duplicate or missing position, and any `Depends on` header that points at a higher number.

## Files per plan

Every plan directory contains exactly three files:

- `spec.md` — WHAT and WHY. Problem, goal, non-goals, user stories, architecture,
  data shapes, UX integration, success metrics, resolved edge cases.
- `plan.md` — HOW. Phases in dependency order, risks table, rollback plan.
- `tasks.md` — granular executable checklist. Every task names the exact file paths it
  touches and its verification step.

## Mandatory header (all three files)

```markdown
> **Status**: `pending` | `partially-implemented` | `implemented` | `blocked` | `superseded`
> **Depends on**: [`other-plan`](../other-plan/spec.md), … (or "nothing")
> **Blocks**: [`other-plan`](../other-plan/spec.md), … (or "nothing")
> **Reality check**: 1-3 lines stating what already exists in `src/` that this plan
> builds on or must not duplicate. Cite real paths.
```

## Reconciliation rules (this pass)

1. **Audit before writing.** Read the actual source files. If a feature (or part of one)
   already exists, the plan marks it `[x]` with a pointer to the real file — never re-plans it.
2. **Fully implemented plans** get status `implemented`, all tasks checked, and a short
   "Delivered" section replacing future-tense prose. Keep them (they're the record); don't delete.
   Plans whose valid scope moved into another plan get status `superseded`, no executable
   unchecked tasks, and an explicit link to the replacement plan and rationale.
3. **Stale assumptions die.** Anything referencing Gemini API keys, 768-dim embeddings,
   BullMQ queues, Stripe webhooks, or other never-built infra is rewritten to match
   `_meta/app-reality.md` and `_meta/ai-policy.md`.
4. **Security and multi-tenancy** follow `_meta/security-policy.md`. Every new or changed table
   declares its data class; tenant-private tables use server-resolved organization context,
   organization-preserving foreign keys, RLS, negative tenant A/B tests, and a safe migration path.
   No plan may use `userId` as a substitute for tenant ownership or trust a client-supplied
   organization ID.
5. **AI features** must state their AI task IDs, tier policy (local-first/server-only),
   output zod schema, cache TTL, plan-tier gating, and fallback behavior — per `ai-policy.md`.
6. **Every cross-plan touchpoint is explicit.** If a plan writes to `builders.metadata`,
   it names the key it owns (e.g. `metadata.aiEnrichment`) and lists other plans sharing
   that surface. Shared surfaces so far: `builders.metadata` (namespaced keys),
   `PLAN_LIMITS`/`PLAN_PRICING` (billing-shared.ts), the search pipeline (`src/lib/search.ts`),
   the AI task registry (`src/shared/lib/ai/tasks.ts`), the HTTP-cron worker pattern,
   the dashboard nav registry `NAV_AREAS` (`src/modules/dashboard/ui/shell/nav-config.ts`) —
   adding a destination means editing BOTH the area's `items` and its `routes` prefix list, or
   `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts` fails on registry integrity,
   and `src/lib/sources/types.ts`'s `SOURCE_NAMES` (any plan enumerating connectors by hand
   goes stale the moment a source ships — type the enumeration as `Record<SourceName, …>` so
   `pnpm type-check` catches it instead of a reviewer),
   `OPERATIONAL_SCHEDULES` (`src/shared/lib/operational-schedules.ts`) — `jobKey` is globally
   unique and every new worker registers there, wrapped in `withJobRun({ jobKey })`,
   and `SEO_SURFACES` (`src/shared/lib/seo/surfaces.ts`) — a governed registry whose
   `DEFAULT_DIRECTIVES` fail closed to `noindex`, so a plan adding a public page that does not
   register a surface ships that page silently unindexed.

   **Allowance tables have a specific hazard.** An allowance that is also *advertised* (on
   `/pricing`, in `PLAN_PRICING.features`) must be keyed `Record<OrganizationTier, number>` and
   read from `entitlement.tier` directly. Do NOT key it `Record<PlanTier, number>` and launder it
   through `resolveLegacyPlanTier`, which lossily collapses `pro_max` into `team`: that is the
   exact shape that let `/pricing` and the enforcing route disagree for seven sprints
   (post-mortem in `src/shared/lib/billing-shared.ts` above `SOURCING_SPRINT_LIMITS`).
   `PLAN_SEAT_LIMITS` remains `Record<PlanTier, number>` legitimately, so the presence of that
   type is not itself the bug — an advertised allowance using it is.
7. **Background work** uses the idempotent HTTP-triggered worker pattern
   (`/api/admin/*/run-worker` hit by VPS cron) — no new queue systems.
8. **Plan-tier gating**: features promised in `PLAN_PRICING` must map to a limit or gate in
   `billing.ts`; if a plan adds a paid feature, its tasks include the billing gate.
9. **Language**: all plan files in English. Spanish remnants get translated.

## tasks.md format

```markdown
- [ ] **Short imperative title**
  - Files: `src/path/to/file.ts`, `src/path/other.tsx`
  - Do: 1-4 lines of concrete instruction (schemas inline where non-obvious).
  - Verify: the command/check that proves it works (test name, curl, UI check).
  - Operator: only when a person must run it — the access or decision required.
```

`Files`, `Do` and `Verify` are mandatory on every **open** task, and `pnpm plans:check-tasks`
fails without them. There is no exemption, because the field that gets dropped is always
`Verify`, and a task nobody can verify is a task nobody can tell is finished. `Verify` may carry
a parenthetical (`Verify (RED):`, `Verify (2026-07-22):`).

Checked tasks are the historical record and may be narrative instead — 243 of them are, and
rewriting finished work to satisfy a format would destroy evidence for no gain. The gate
therefore only holds open tasks to the template: those are the ones someone is about to execute.

`Operator` is the fourth, optional field, and it exists because some work genuinely cannot be
done by an agent: it needs production SSH, a real credential, a legal approval, a decision, or
elapsed time. Those tasks still get `Files`/`Do`/`Verify` — the person doing it needs them just
as much — and `Operator` states plainly why an agent must stop and hand over. Writing a fake
verification step for such a task is worse than leaving it blank, because it invites an agent to
claim it passed.

Do not use a `- [ ]` checkbox for anything that is not work you intend someone to do. Scope you
have decided against, ideas awaiting a new specification, and follow-ups belonging to another
plan go in a prose list under a clear heading. A checkbox reads as "pending" to every reader,
inflates every count, and invites an agent to implement unapproved scope.

Tasks are ordered so the feature is always shippable at any checkpoint (schema → lib+tests →
API → UI → gating/polish). A competent dev (or agent) must be able to execute tasks.md
top-to-bottom without reading anything else except the files it cites.

**Paths and commands must be real.** A plan is only followable literally if every path it names
sits in the tree that exists and every `pnpm` script it tells you to run is in `package.json`.
When a tree moves, the plans that name it move with it in the same change —
`pnpm plans:check-tasks` fails otherwise.
