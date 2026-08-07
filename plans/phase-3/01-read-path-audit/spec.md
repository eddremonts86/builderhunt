# Specification — read-path audit and unbounded-read detector

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Earlier counts (~50 request reads, 13 worker scans, 11 aggregates) are a
> dated survey, not acceptance criteria. `src/` has changed since it was taken. This plan produces a
> fresh inventory from the TypeScript AST and records its commit SHA; no script measures it today.

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

The initial split from the survey is ≈23 page / ≈11 model-bounded / ≈10 batch. Confirming or
correcting each row against the real source is the substance of this plan — a read classified
`page` that actually must cover every row (a deletion, an export) becomes a bug in plan 12.

## Success metrics

- `node scripts/check-unbounded-reads.mjs` runs in under 5 seconds and prints schema-valid JSON.
- Its `unbounded` count equals the number of page + model-bounded + batch rows in the committed
  classification, with no unclassified remainder.
- Re-running after adding a deliberate unbounded read in a route handler and in a non-exported helper
  increments the count by exactly 2.
- No false positive from `Buffer.from`/`Array.from` and no aggregate counted as a list read.

## Resolved edge cases

- **A function that both aggregates and lists.** Counted as a list read; the aggregate exemption
  applies only when the function returns a scalar.
- **A read behind a feature flag that is off** (e.g. `ENRICHMENT_ENABLED=false`). Still counted —
  a flag is not a bound, and the flag will flip.
- **Reads in `tests/`.** Out of scope; the script walks `src/` only.
