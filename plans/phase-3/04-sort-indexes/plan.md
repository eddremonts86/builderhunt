# Plan — an index behind every sortable column

> **Status**: `pending`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md)
> **Blocks**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: One next-free generated migration plus one unit test. Reuse the 114 indexes
> currently declared wherever they already match; recalculate the count at execution time.

## Sequence

1. **Audit the indexes that exist at execution time against the capabilities' `sortable` sets.** Most tenant tables
   already carry `(organization_id, created_at)`, which covers the common default sort for free.
   Write down what is already covered before generating anything.
2. **Declare only the missing indexes**, generate, regenerate the hash manifest.
3. **Add the guard test last**, against a schema that already satisfies it, so its first red run is
   a deliberate one.

## Why this comes before the UI

A header is either sortable or it is not, and that has to be true before a column header becomes
clickable. Wiring the shell first would mean shipping headers that sort correctly and slowly —
the hardest kind of regression to notice.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Index bloat: a composite per sortable column across 19 tables | Medium | Medium — write amplification and disk | Step 1 reuses existing composites; only genuinely missing indexes are added, and the list is reviewed before generating |
| The migration is generated with an unintended schema diff | Medium | High — an accidental column change reaching production | Read the generated next-free SQL before committing and confirm it is `CREATE INDEX` only; `pnpm test:migrations:local` rehearses it |
| Forgetting the hash manifest regeneration | **High** — it happened on `0082` and `0083` | Low — a red gate, caught locally | `verify-migration-integrity.mjs --write` is its own task with its own verify step |
| A `NULLS LAST` mismatch makes an index unusable while the guard passes | Medium | Medium — a slow sort that looks guarded | The guard checks the modifier; plan 13's `EXPLAIN` assertion catches what the guard cannot |

## Rollback

Index-only. `DROP INDEX` is safe and immediate, and no application code depends on an index beyond
its speed. If the phase is abandoned the indexes are harmless to keep.
