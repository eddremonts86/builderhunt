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

## Met by the shipped detector, 2026-08-10

This plan was revised (upstream `e5bc8a2d5`) after a text-matching detector had already shipped, and
the revision raised the bar in four ways the text version did not clear. The rewrite onto the
TypeScript compiler API (`scripts/lib/unbounded-reads.mjs`) clears all four:

| Required | Now | Evidence |
|---|---|---|
| TypeScript compiler API | Yes | `ts.createSourceFile` per file; the brace scanner and its `skipString`/`skipTrivia` lexer are gone |
| `commit` and `entries[]` in the JSON | Yes | `--json` emits every entry; both output modes carry the commit SHA |
| A route handler *and* a non-exported helper each increment by 1 | Yes | `scopeOf` resolves method, `const`, and property-assignment scopes regardless of export |
| `.limit()` associated with its own query chain | Yes | `chainOf` walks only the call spine, so a sibling query's bound never counts |

The rewrite found **45 reads the text version reported as zero**, in exactly the shapes the blind-spot
list predicted. All 45 are resolved — bounded, computed in SQL, drained, or exempted with a stated
reason — and the count is back to zero, this time against a detector that can see the whole surface.

Two shapes were found during the sweep rather than predicted here:

- **`selectDistinct` / `selectDistinctOn`.** List reads exactly like `select`, and initially unseen.
  `listNotedOrganizationBuilders` opens with `selectDistinct({ builderId }).from(builderNotes)` across
  a whole organization's notes; only the *second* query in that function was being reported.
- **A bounded read reported as unbounded.** `listAccessRequests` carried `OPERATOR_LIST_LIMIT` on both
  branches but built them from a shared `const query = db.select().from(…)` — blind spot 2 below,
  firing in the false-positive direction. Rewritten as one chain per branch, because at review time a
  false positive is indistinguishable from a real one.

## Known blind spots

Plan 13's gate is worth exactly as much as this list is honest. Four of the five recorded here are
closed; each closure has a case in `tests/unit/scripts/lib/unbounded-reads.test.ts`, so a regression
fails a test rather than quietly widening the gap again.

1. ~~**Reads inside a route handler.**~~ **Closed.** `scopeOf` walks to the nearest named scope,
   including a property assignment inside an object literal, so `{ GET: async () => … }` inside
   `createFileRoute(…)({…})` is attributed to `GET`. Found the read at
   `src/routes/api/me/sessions/index.ts:48` this list predicted, and the one in `/api/status` it did
   not.

2. ~~**A `.limit(` that bounds only part of the function.**~~ **Closed.** The bound belongs to the
   call chain, not to the body. This was the worst of the five: not a coverage gap but a false
   negative in a required gate, reportable only under an opt-in `--mixed` flag which is now gone.
   `loadAccountExportSource` was exactly as described — `.limit(1)` on its user and account lookups
   and no bound on the `builder_claim_requests` read beside them.

   It also fired in the *other* direction, which this list did not anticipate: a genuinely bounded
   read written as `const query = db.select().from(…)` and finished by two branches was reported as
   unbounded. See item 5.

3. **Raw `sql` templates and `db.execute`.** *Still open, unchanged.*
   `src/shared/lib/repositories/platform-billing.ts:69` `getPlatformUserBillingSummary` reads through
   `db.execute(sql\`select * from platform_admin_user_billing_summary(…)\`)`. Whatever that Postgres
   function returns, this script has no opinion about it. Closing it means reading SQL text or the
   function body, neither of which a syntax tree provides.

4. ~~**Reads inside a non-exported helper.**~~ **Closed.** Export status is recorded on the entry
   (`exported: false`) and never used to filter. `loadProjectableComponents` is now reported in its own
   right rather than by accident of its caller.

5. ~~**The relational `findMany({ limit })` form.**~~ **Closed, and it was worth closing before a call
   site existed.** `findMany` takes `limit` as an object property, not as a `.limit()` method, so the
   old pairing would have reported every correctly bounded relational query as unbounded. There are
   still zero `findMany` call sites in `src/`, but the branch is no longer untested: three fixtures
   cover bounded, unbounded, and the property-versus-method distinction.

**New, replacing them: a chain split across statements.**

```ts
const q = db.select().from(t)
if (wantAll) return q          // unbounded
return q.limit(50)             // bounded
```

The detector sees two chains and cannot connect them. It has fired in both directions —
`listAccessRequests` was a false positive of exactly this shape — and following it needs the type
checker plus a dataflow pass, not a syntax tree. The mitigation is stylistic and stated where it
matters: write the chain whole, so its bound is visible to a reader and to the gate at the same time.

## Resolved edge cases

- **A function that both aggregates and lists.** Counted as a list read; the aggregate exemption
  applies only when the function returns a scalar.
- **A read behind a feature flag that is off** (e.g. `ENRICHMENT_ENABLED=false`). Still counted —
  a flag is not a bound, and the flag will flip.
- **Reads in `tests/`.** Out of scope; the script walks `src/` only.
