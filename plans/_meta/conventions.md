# Plan Conventions — How Every Plan Must Be Written

Applies to every directory in `plans/`. A plan is "100% implementation-ready" only when it
follows this document. Written 2026-07-19 during the full plan-reconciliation pass.

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
   the AI task registry (`src/shared/lib/ai/tasks.ts`), the HTTP-cron worker pattern.
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
```

Tasks are ordered so the feature is always shippable at any checkpoint (schema → lib+tests →
API → UI → gating/polish). A competent dev (or agent) must be able to execute tasks.md
top-to-bottom without reading anything else except the files it cites.
