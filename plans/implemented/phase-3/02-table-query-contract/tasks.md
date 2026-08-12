# Tasks — the table query contract

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`05-table-shell`](../05-table-shell/spec.md)
> **Reality check**: `src/shared/lib/table/` exists — `constants.ts`, `types.ts`, `columns.ts`, `query-url.ts`, `cursor.ts`, `index.ts`. 26 unit tests across `tests/unit/shared/lib/table/`. HMAC construction copied from `src/shared/lib/security/feed-capability.ts:33`.

- [x] **Define the data types and the page size**
  - Files: `src/shared/lib/table/types.ts`, `src/shared/lib/table/columns.ts`,
    `src/shared/lib/table/constants.ts`
  - Do: `TableQuery`, `PageRequest`, `PageResult` in `types.ts` (no React import). `ColumnDef` in
    `columns.ts`, the only file importing React. `TABLE_PAGE_SIZE = 50` in `constants.ts`.
  - Verify: `pnpm type-check` clean; `grep -n react src/shared/lib/table/types.ts` returns nothing.
  - Done. `types.ts` imports nothing at all, so the grep is empty and the spec's stronger claim
    ("importing nothing from `src/` except `env.ts`") holds for the data half too — only
    `cursor.ts` reads `env`. `types.ts` also carries `TableSearch`, the parsed shape `validateSearch`
    returns, because the codec and the shell both need to name it.

- [x] **Write the URL codec as a reusable validateSearch schema**
  - Files: `src/shared/lib/table/query-url.ts`, `tests/unit/shared/lib/table/query-url.test.ts`
  - Do: `tableSearchSchema` parsing `?cursor=&sort=&filter.<id>=&group=&as=&q=` into
    `{ query, page, renderer }`. Multi-value filters via repeated params. Unknown params are
    ignored rather than rejected — a stale link must still load.
  - Verify: `pnpm test tests/unit/shared/lib/table/query-url.test.ts`, including a `fast-check`
    property that `parse(serialize(q))` deep-equals `q`.
  - Done: 17 tests, two of them `fast-check` properties at 500 runs each. The second property is
    not in the checklist and earns its place: `parse(serialize(q))` deep-equalling `q` says
    nothing about what happens through a real `URLSearchParams`, and the shell round-trips through
    one on every interaction. It asserts the *rendered URL* is stable, not just the object.

    Three decisions the checklist left open, each recorded in the module:
    - **`limit` is not a URL parameter.** Page size is what the server is willing to serve; a link
      that can widen its own page is a link that can ask for the whole table. `tableSearchSchema`
      always returns `TABLE_PAGE_SIZE` and `serializeTableSearch` never emits a limit.
    - **The round trip is an identity on *canonical* state.** An empty search, an empty filter
      array and the default renderer are dropped and restored from their defaults. The property
      test generates canonical values and says so, rather than quietly generating around a
      collapse it would otherwise have caught.
    - **Column ids are shape-checked at the edge** (`/^[A-Za-z][A-Za-z0-9_-]*$/`). Not
      authorization — plan 03's per-table allowlist is that — but `sort=name;drop table:asc`
      should not reach the allowlist as a lookup key in the first place.

- [x] **Mint and verify signed keyset cursors**
  - Files: `src/shared/lib/table/cursor.ts`, `tests/unit/shared/lib/table/cursor.test.ts`
  - Do: payload `{ t, s, q, a, k }` (table, sort, normalized-query fingerprint, server-resolved
    access scope, key tuple) → base64url → `createHmac('sha256', secret)` over
    `'builderhunt:table-cursor:v1:' + payload`, compared with `timingSafeEqual`. Read the secret
    through `src/shared/lib/env.ts`; reuse an existing signing secret if one is already loaded
    there rather than adding an environment variable.
  - Verify: `pnpm test tests/unit/shared/lib/table/cursor.test.ts` — separate assertions that a
    tampered tuple, a cursor minted for a different filter/search/sort, and cursors crossing
    tenant/account/platform/public scopes each throw.
  - **Partly done.** 9 tests: a tampered tuple, a different *sort*, a different organization, a
    different table, a different secret, a malformed token, and a signature computed with
    `feed-capability.ts`'s prefix over the identical payload — the last one is what proves the
    versioned prefix, not just the shared secret, is doing the separating.

    **Two requirements this revision adds are not met**, and both are real:
    - **The cursor does not bind the filter or the search term.** Its payload is
      `{ table, sortDescriptor, organizationId, tuple }`. Presenting a cursor minted under
      `filter.source=github` while asking for `filter.source=gitlab` is accepted today: the keyset
      predicate is applied against a different `WHERE`, so the page starts from a row's position in
      an ordering the new filter does not produce. That skips or repeats rows. It is a correctness
      bug rather than a boundary one — the tenant predicate still holds — but it is exactly the
      class of silent wrongness this phase exists to remove.
    - **Only tenant and platform scopes exist.** `organizationId: string | null` distinguishes
      tenant-scoped from global; there is no account-subject or public scope in the payload, so a
      cursor cannot be refused for crossing between them.

    Both are payload changes plus verification, which invalidates every cursor minted before the
    change — acceptable, since a rejected cursor drops the client to page one by design.

    The secret is `BETTER_AUTH_SECRET`, no new environment variable. That is the same reuse
    `access-requests.ts:61` already makes for its 7-day invite token, and for the same reason: a
    cursor is short-lived, never stored, and carries no personal data. It is *not* the reuse
    `PROFILE_REMOVAL_HMAC_KEY` is forbidden from making, which is about hashing stored PII.

    `verifyTableCursor` throws `TableCursorError` carrying `status = 400`, deliberately not 403:
    from the server's side a forged cursor and a stale one are the same malformed request, and
    telling them apart in the response would tell a caller which of the two they achieved.

- [x] **Export the module surface**
  - Files: `src/shared/lib/table/index.ts`
  - Do: re-export the types, the schema, the cursor helpers and `TABLE_PAGE_SIZE`. Nothing in the
    app imports it yet — expected at this checkpoint.
  - Verify: `pnpm type-check`, `pnpm lint`, `pnpm test` green; `pnpm build` succeeds.
  - Done, with **one deliberate divergence: `index.ts` re-exports the cursor's *types* but not its
    two functions.** `cursor.ts` imports `node:crypto`, and `index.ts` is what the shell will
    import in plan 05. Re-exporting the functions would put a single
    `import { TABLE_PAGE_SIZE } from '~/shared/lib/table'` between us and a server module in the
    client bundle.

    This is not hypothetical caution. `scripts/check-route-client-boundary.mjs` exists because on
    2026-07-28 one exported route symbol that referenced the server layer dragged the `postgres`
    driver into the browser, and **type-check, lint, 4236 unit tests and a production build all
    passed while every page was dead** — the build's tree-shaking is precise where the dev
    transform is not, so no build artifact reveals it. That means the `pnpm build` in this task's
    own verify line could not have caught it either. Only the server mints or verifies a cursor;
    a client holds it as an opaque string, so nothing is lost by importing
    `~/shared/lib/table/cursor` directly from server code.

    Verification, all four green on 2026-08-07: `tsc --noEmit` exit 0 · `eslint .` exit 0 (113
    pre-existing warnings, 0 errors) · `vitest run` 419 files, 5978 passed, 23 skipped ·
    `vite build` exit 0.
