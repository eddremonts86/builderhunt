# Plan — the table query contract

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`05-table-shell`](../05-table-shell/spec.md)
> **Reality check**: All new files under `src/shared/lib/table/`. Nothing in the app imports them when this plan closes.

## Sequence

1. **Types and the page-size constant.** Nothing to verify beyond `type-check`, but everything
   later reads them.
2. **URL codec, with the round-trip property test.** Written before the cursor, because the sort
   descriptor the cursor signs is defined by the codec.
3. **Signed cursor**, reusing the existing HMAC construction.

Types, then codec, then cursor: each depends on the previous one's shape, and none depends on SQL
or React.

## Why this plan ships nothing visible

Deliberate. The contract is the seam that makes the engine replaceable later, and it is the one
piece that is expensive to change once 19 surfaces depend on it. Getting it wrong is the failure
mode where the whole phase is redone; getting it right costs a day.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The contract is shaped by nothing real and turns out wrong at the first caller | Medium | Medium — a rewrite of plans 03 and 05 | Plan 07 migrates a real surface before 08–12 repeat it; the contract may change up to that point and is frozen after |
| An unsigned or weakly signed cursor becomes an injection vector | Low by design | **Critical** — cross-tenant read | Signature covers table, sort and organization, not only the tuple; three separate negative tests; the secret comes from the existing `env.ts` loader rather than a new variable |
| `React.ReactNode` in `ColumnDef` drags React into a server-imported module | Medium | Low — a build error, found immediately | `ColumnDef` lives in its own file so server code imports only the data types |

## Rollback

New files, nothing imports them. Delete the directory.
