# Specification — read-path audit and unbounded-read detector

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Earlier counts (~50 request reads, 13 worker scans, 11 aggregates) are a
> dated survey, not acceptance criteria. `src/` has changed since it was taken. This plan produces a
> fresh inventory from the TypeScript AST and records its commit SHA.
>
> **A text-matching detector shipped first and is still what runs.** It reports
> `{"unbounded":96,"aggregates":16,"exempted":0}` and its classification is in [`tasks.md`](./tasks.md).
> It reached the same two conclusions this revision is built on — that route handlers are invisible
> to it and that a `.limit()` on one query is mistaken for a bound on another — and *documented*
> them as blind spots rather than closing them. The revision is right that documenting is not
> closing. See "Not yet met by the shipped detector" below.

## Problem

We know the app has unbounded reads because a survey found them once. Without a script the count
is unverifiable, un-trackable across the rest of this phase, and impossible to defend as a CI
gate later. Worse, a hand-written list goes stale the first time someone adds a repository
function.

## Goal

A committed classification of every unbounded read, and a script that reproduces the count on
demand so every later plan can prove it made progress.

## Non-goals

- **Fixing any read.** This plan changes no runtime behaviour. The fixes are plans 07–12.
- **Failing CI.** The detector exits 0 here. It becomes a gate in plan 13, after its accuracy has
  been checked against the hand-made classification.

## The detector

`scripts/check-unbounded-reads.mjs` walks `src/**/*.{ts,tsx}` with the installed TypeScript compiler
API. It reports Drizzle list-query call chains and `findMany` calls that have no explicit bound,
including queries inside non-exported helpers and route handlers. Regex over exported function bodies
is explicitly rejected: it misses nested handlers and mistakes a `.limit()` on another query for a
bound on the target query.

It must handle three classes of false positive found during the survey:

1. `Buffer.from(`, `Array.from(`, `Object.from(`, `Set.from(`, `Map.from(` matching a naive
   `.from(` search — this alone inflated the first survey from 50 to 113.
2. Scalar aggregates (`count(`, `sum(`, `sql\`count`) which return a number, not rows.
3. Reviewed exceptions, via a `// unbounded-read-ok: <reason>` comment above the function.

Output is machine-readable and includes file/line/kind entries so later plans can reconcile it:

```json
{"commit":"<sha>","unbounded":0,"aggregates":0,"exempted":0,"entries":[]}
```

## The classification

Each unbounded read is assigned **page**, **model-bounded** or **batch** per the phase README,
and committed as a table in this plan's `tasks.md`. That table is the work list for plans 10 and
12; the mechanism chosen here is what those plans implement.

The survey guessed ≈23 page / ≈11 model-bounded / ≈10 batch. The committed split, read against
the real source, is **38 page / 26 model-bounded / 33 batch**. Confirming or correcting each row
was the substance of this plan — a read classified `page` that actually must cover every row (a
deletion, an export) becomes a bug in plan 12, so `batch` was the default whenever the consumer
needed completeness and no data-model ceiling could be named.

## Success metrics

- `node scripts/check-unbounded-reads.mjs` runs in under 5 seconds and prints schema-valid JSON.
- Its `unbounded` count equals the number of page + model-bounded + batch rows in the committed
  classification, with no unclassified remainder.
- Re-running after adding a deliberate unbounded read in a route handler and in a non-exported helper
  increments the count by exactly 2.
- No false positive from `Buffer.from`/`Array.from` and no aggregate counted as a list read.

## Not yet met by the shipped detector

This plan was revised (upstream `e5bc8a2d5`) after a text-matching detector had already shipped, and
the revision raises the bar in three ways the current script does not clear:

| Required now | Shipped | Gap |
|---|---|---|
| TypeScript compiler API | Text matching with a brace scanner | Blind spots 1 and 4 below are structural, not fixable by better regex |
| `commit` and `entries[]` in the JSON | `{unbounded, aggregates, exempted}` only | Plan 13 wants entries to reconcile against |
| A route handler *and* a non-exported helper each increment by 1 | Neither is seen at all | Blind spots 1 and 4 |
| `.limit()` associated with its own query chain | Any `.limit(` in the body counts | Blind spot 2 — nine live cases, one in the GDPR export path |

The blind-spot list below is what the shipped detector honestly cannot see, and it is precisely the
list the revision asks to eliminate. Rewriting it on the AST closes 1, 2 and 4 outright; 3 and 5 stay.

## Known blind spots

The detector reads source text, so it sees the shapes it was told to look for and nothing else.
Each of these is a way an unbounded read can exist in `src/` and be reported as absent. Plan 13's
gate is worth exactly as much as this list is honest.

1. **Reads inside a route handler.** Only exported *function* declarations and exported
   `const … = () =>` bindings are examined. A TanStack route is `export const Route =
   createFileRoute(…)({…})`, which matches neither, so every read written inline in a handler is
   invisible — `src/routes/api/me/sessions/index.ts:48` (unbounded, bounded in practice only by
   the caller's id array) and `src/routes/api/admin/solutions/gold-briefs.ts:46` (bounded, by a
   `.limit(500)` the detector also cannot see).

2. **A `.limit(` that bounds only part of the function.** The heuristic is "the body contains
   `.limit(`", so one bounded lookup marks the whole function bounded. Nine functions in `src/`
   have more selects than limits — run `node scripts/check-unbounded-reads.mjs --mixed`. The
   consequential one is `src/shared/lib/repositories/account-privacy.ts:61`
   `loadAccountExportSource`: it bounds its user and account lookups with `.limit(1)` and then
   reads `builder_claim_requests` by email with no bound at all, inside the GDPR export path.

3. **Raw `sql` templates and `db.execute`.** `src/shared/lib/repositories/platform-billing.ts:69`
   `getPlatformUserBillingSummary` reads through `db.execute(sql\`select * from
   platform_admin_user_billing_summary(…)\`)`. Whatever that Postgres function returns, this
   script has no opinion about it.

4. **Reads inside a non-exported helper.** `loadProjectableComponents`
   (`src/lib/solutions/indexing/project-components.ts:131`) is where the projection sweep's read
   actually lives; it is counted here only because its exported caller `projectComponents`
   happens to contain a second, visible `.select`. A non-exported helper whose exported caller
   has no select of its own would not be counted at all.

5. **The relational `findMany({ limit })` form.** `LIST_READ` matches `.findMany(`, but
   `HAS_LIMIT` matches `.limit(` — the relational API passes `limit` as an object property, so a
   properly bounded `findMany` would be reported as unbounded. There are zero `findMany` call
   sites in `src/` today, so this branch has never run against real code and should be treated as
   untested rather than working.

## Resolved edge cases

- **A function that both aggregates and lists.** Counted as a list read; the aggregate exemption
  applies only when the function returns a scalar.
- **A read behind a feature flag that is off** (e.g. `ENRICHMENT_ENABLED=false`). Still counted —
  a flag is not a bound, and the flag will flip.
- **Reads in `tests/`.** Out of scope; the script walks `src/` only.
