# Specification — read-path audit and unbounded-read detector

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `src/` contains ~137 bounded list reads and ~50 request-serving reads with no `.limit()`, plus 13 worker scans and 11 scalar aggregates. No script measures this today, so the number is a one-off survey rather than a tracked figure. `scripts/check-route-coverage.mjs` is the precedent for a repo-shape gate.

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

`scripts/check-unbounded-reads.mjs` walks `src/**/*.{ts,tsx}`, and for each exported function
whose body contains a Drizzle list read (`.select({`, `.select()`, `db.select`, `tx.select`,
`findMany(`) reports it when the body has no `.limit(`.

It must handle three classes of false positive found during the survey:

1. `Buffer.from(`, `Array.from(`, `Object.from(`, `Set.from(`, `Map.from(` matching a naive
   `.from(` search — this alone inflated the first survey from 50 to 113.
2. Scalar aggregates (`count(`, `sum(`, `sql\`count`) which return a number, not rows.
3. Reviewed exceptions, via a `// unbounded-read-ok: <reason>` comment above the function.

Output is machine-readable so later plans can assert on it:

```json
{"unbounded":50,"aggregates":11,"exempted":0}
```

## The classification

Each unbounded read is assigned **page**, **model-bounded** or **batch** per the phase README,
and committed as a table in this plan's `tasks.md`. That table is the work list for plans 10 and
12; the mechanism chosen here is what those plans implement.

The initial split from the survey is ≈23 page / ≈11 model-bounded / ≈10 batch. Confirming or
correcting each row against the real source is the substance of this plan — a read classified
`page` that actually must cover every row (a deletion, an export) becomes a bug in plan 12.

## Success metrics

- `node scripts/check-unbounded-reads.mjs` runs in under 5 seconds and prints the JSON above.
- Its `unbounded` count equals the number of page + model-bounded + batch rows in the committed
  classification, with no unclassified remainder.
- Re-running after adding a deliberate unbounded read increments the count by exactly 1.
- No false positive from `Buffer.from`/`Array.from` and no aggregate counted as a list read.

## Resolved edge cases

- **A function that both aggregates and lists.** Counted as a list read; the aggregate exemption
  applies only when the function returns a scalar.
- **A read behind a feature flag that is off** (e.g. `ENRICHMENT_ENABLED=false`). Still counted —
  a flag is not a bound, and the flag will flip.
- **Reads in `tests/`.** Out of scope; the script walks `src/` only.
