# Tasks — migrate the platform content managers

> **Status**: `pending`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `tests/regression/test-status-and-trust.mjs` drives these managers by `data-testid`.

- [ ] **Capture the current test ids before editing anything**
  - Files: `09-migrate-platform-content/plan.md` (record the list there)
  - Do: `grep -o 'data-testid="[^"]*"' src/modules/admin/content/*.tsx | sort -u` and paste the
    result into the plan. This list is the contract for every task below.
  - Verify: the captured list is non-empty and includes the ids
    `tests/regression/test-status-and-trust.mjs` references.

- [ ] **Migrate the changelog manager**
  - Files: `src/modules/admin/content/ChangelogManager.tsx`,
    `src/shared/lib/table/capabilities/changelog.ts`
  - Do: `DataTable` with `rowTestId` reproducing today's per-row id exactly. Keep the tag filter as
    toolbar facet chips and the "in git" badge as a cell renderer. Sortable date (default,
    descending) and title.
  - Verify: `node tests/regression/test-status-and-trust.mjs` green; `git diff` shows no changed
    `data-testid` value; tag chip counts match the previous UI on the same content set.

- [ ] **Migrate the roadmap manager**
  - Files: `src/modules/admin/content/RoadmapManager.tsx`,
    `src/shared/lib/table/capabilities/roadmap.ts`
  - Do: `DataTable` with `rowTestId` matching today's ids. Status filter as facet chips; the
    per-row status control stays a row action. Sortable order (default), status and title.
  - Verify: `node tests/regression/test-status-and-trust.mjs` green; change an item's status and
    confirm the public `/roadmap` page reflects it.

- [ ] **Migrate the blog library as a file-backed table**
  - Files: `src/modules/admin/content/BlogLibrary.tsx`, `src/shared/lib/blog.ts`,
    `src/shared/lib/table/capabilities/blog.ts`
  - Do: paginate the parsed post list **in the loader**, behind the same `PageResult` shape, so the
    shell cannot tell it is not SQL. Sorting and filtering run over the complete parsed set, which
    is correct precisely because it is complete. Mark the capability non-SQL. Stays read-only.
  - Verify: the library lists every post in `content/posts/`; sorting by date matches
    `ls content/posts` ordering by frontmatter date.

- [ ] **Record the non-SQL exemption where the guard can see it**
  - Files: `src/shared/lib/table/capabilities/blog.ts`,
    `tests/unit/shared/lib/table/capability-index.test.ts`
  - Do: the blog capability is exempt from the index guard because there is no table to index. The
    exemption is a declared flag on the capability, checked by the guard — not a name-pattern skip
    inside the test.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability-index.test.ts` passes and its output
    names the exempted capability rather than silently ignoring it.
