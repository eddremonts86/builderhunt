# Tasks — the table query contract

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`05-table-shell`](../05-table-shell/spec.md)
> **Reality check**: New module. HMAC construction copied from `src/shared/lib/security/feed-capability.ts:33`.

- [ ] **Define the data types and the page size**
  - Files: `src/shared/lib/table/types.ts`, `src/shared/lib/table/columns.ts`,
    `src/shared/lib/table/constants.ts`
  - Do: `TableQuery`, `PageRequest`, `PageResult` in `types.ts` (no React import). `ColumnDef` in
    `columns.ts`, the only file importing React. `TABLE_PAGE_SIZE = 50` in `constants.ts`.
  - Verify: `pnpm type-check` clean; `grep -n react src/shared/lib/table/types.ts` returns nothing.

- [ ] **Write the URL codec as a reusable validateSearch schema**
  - Files: `src/shared/lib/table/query-url.ts`, `tests/unit/shared/lib/table/query-url.test.ts`
  - Do: `tableSearchSchema` parsing `?cursor=&sort=&filter.<id>=&group=&as=&q=` into
    `{ query, page, renderer }`. Multi-value filters via repeated params. Unknown params are
    ignored rather than rejected — a stale link must still load.
  - Verify: `pnpm test tests/unit/shared/lib/table/query-url.test.ts`, including a `fast-check`
    property that `parse(serialize(q))` deep-equals `q`.

- [ ] **Mint and verify signed keyset cursors**
  - Files: `src/shared/lib/table/cursor.ts`, `tests/unit/shared/lib/table/cursor.test.ts`
  - Do: payload `{ t, s, o, k }` → base64url → `createHmac('sha256', secret)` over
    `'builderhunt:table-cursor:v1:' + payload`, compared with `timingSafeEqual`. Read the secret
    through `src/shared/lib/env.ts`; reuse an existing signing secret if one is already loaded
    there rather than adding an environment variable.
  - Verify: `pnpm test tests/unit/shared/lib/table/cursor.test.ts` — separate assertions that a
    tampered tuple, a cursor minted for a different sort, and a cursor minted for a different
    organization each throw.

- [ ] **Export the module surface**
  - Files: `src/shared/lib/table/index.ts`
  - Do: re-export the types, the schema, the cursor helpers and `TABLE_PAGE_SIZE`. Nothing in the
    app imports it yet — expected at this checkpoint.
  - Verify: `pnpm type-check`, `pnpm lint`, `pnpm test` green; `pnpm build` succeeds.
