# Specification — the table query contract

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`05-table-shell`](../05-table-shell/spec.md)
> **Reality check**: Two incompatible pagination shapes exist. `src/modules/search/components/SearchPage.tsx:395-441` counts pages (`page`/`perPage`/`hasMore`); `src/routes/api/sprints/$sprintId/results.ts` emits a base64 *offset*. Pure filter/sort helpers in `src/lib/sprints/results.ts` are the precedent for keeping model functions pure. HMAC token signing already exists at `src/shared/lib/security/feed-capability.ts:33`.

## Problem

Every table that follows needs the same four things: a way to describe its columns, a way to
carry filter/sort/group state in a URL, a way to ask for the next page, and a way to describe
what came back. Today each surface invents its own. Two different pagination shapes already
exist and a third would be invented by the next table.

## Goal

One set of types, one URL codec, one cursor format — small enough to read in a sitting, and
written before anything depends on them so they are not shaped by the first caller's accident.

## Non-goals

- **No SQL.** The keyset builder is plan 03.
- **No components.** The shell is plan 05.
- **No per-table capability allowlist.** That belongs with the SQL that enforces it (plan 03).

## Types

```ts
export interface ColumnDef<Row> {
  id: string
  header: string
  cell: (row: Row) => React.ReactNode
  /** Sorting and grouping need a primitive; a cell rendering an avatar still sorts by name. */
  value?: (row: Row) => string | number | null
  align?: 'start' | 'end'
  sortable?: boolean
  groupable?: boolean
  /** Which columns survive the stacked renderer below `md`. */
  priority?: 'primary' | 'secondary' | 'detail'
}

export interface TableQuery {
  search: string
  filters: Record<string, string[]>
  sort: Array<{ id: string; dir: 'asc' | 'desc' }>
  groupBy: string | null
}

export interface PageRequest {
  cursor: string | null
  /** Server clamps to TABLE_PAGE_SIZE; a larger client value is ignored, not honoured. */
  limit: number
}

export interface PageResult<Row> {
  rows: Row[]
  nextCursor: string | null
  /** Exact count when the backend can know it; null for federated/provider-backed results. */
  total: number | null
  facets: Record<string, Array<{ value: string; count: number }>>
}
```

`total: null` is not zero and must never be rendered as such. It means the backend cannot know the
complete cardinality without exhausting third-party APIs. The shell omits `aria-rowcount` and shows
the loaded count plus whether another cursor exists. SQL-backed capabilities normally return an
exact total; a capability may opt out only with a documented measurement showing count cost is
material.

`TABLE_PAGE_SIZE = 50` is exported from `src/shared/lib/table/constants.ts`. No route, component
or repository may literal a page size — that is what lets the number change in one place.

## URL codec

`tableSearchSchema` parses `?cursor=&sort=&filter.<id>=&group=&as=&q=` into
`{ query: TableQuery, page: PageRequest, renderer: string }`, usable directly as a route's
`validateSearch`. This is already the repo's idiom — `src/routes/_dashboard/admin/content.tsx`
uses `validateSearch` for `?tab=`.

Round-trip stability is a requirement, not a nicety: `parse(serialize(q))` must deep-equal `q`,
because the shell writes the URL and the loader reads it on every interaction.

## Cursor format

The cursor carries the last row's values for every `ORDER BY` term, so plan 03 can emit a tuple
comparison. It is **signed**, because an unsigned cursor is a way for a client to supply
arbitrary column values into a comparison — the exact injection surface this design exists to
close.

Payload `{ t: table, s: sortDescriptor, q: queryFingerprint, a: accessScope, k: tuple }`, base64url, signed with
`createHmac('sha256', secret).update('builderhunt:table-cursor:v1:' + payload)` and compared with
`timingSafeEqual` — the same construction as `feed-capability.ts:33`, not a new scheme.

`accessScope` is one of `tenant:<organizationId>`, `account:<userId>`, `platform`, or `public` and
is resolved by the server handler, never accepted from the client. `queryFingerprint` hashes the
normalized search, filters, grouping, renderer-relevant mode and any opaque pre-filter identity.
Verification rejects a mismatched table, sort descriptor, query fingerprint, or access scope. A
rejected cursor is a 400; the shell drops it and refetches page one rather than rendering a mixed
list. Changing any query control clears the cursor before navigation.

## Success metrics

- `pnpm type-check` clean, with the data types importing nothing from `src/` except `env.ts`.
- Round-trip property test passes over generated `TableQuery` values (`fast-check` is already a
  devDependency used elsewhere in the suite).
- A tampered cursor, a cursor from another query/sort, and a cursor from another access scope each
  throw — asserted individually.
- `grep -rn 'perPage\|limit: 30' src` still shows the old call sites; this plan does not touch
  them, and plan 13 asserts they are gone.

## Resolved edge cases

- **No cursor.** `cursor: null` means page one; the sort comes from the capability's default.
- **A cursor whose query or sort the URL no longer requests.** Signature payload mismatch → 400
  → page one; first-party UI clears the cursor when a control changes.
- **`limit` above `TABLE_PAGE_SIZE`.** Clamped silently. A client cannot widen its own page.
- **An empty `filters` value array.** Means "no filter on this dimension", not "match none".
