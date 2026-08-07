# Plan — migrate the platform content managers

> **Status**: `pending`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Three UI files plus `src/shared/lib/blog.ts`. No migration, no index — the blog is file-backed and changelog/roadmap are small.

## The test-id contract (captured 2026-08-07, before any edit)

`tests/regression/test-status-and-trust.mjs` drives these managers by id, so this list is the
contract every task below is measured against. Captured with
`grep -o 'data-testid="[^"]*"' src/modules/admin/content/*.tsx | sort -u`:

| File | Test id |
|---|---|
| `BlogLibrary.tsx` | `admin-blog-library` |
| `BlogLibrary.tsx` | `admin-blog-search` |
| `BlogLibrary.tsx` | `admin-blog-view` |
| `ChangelogManager.tsx` | `admin-changelog-cancel` |
| `ChangelogManager.tsx` | `admin-changelog-content` |
| `ChangelogManager.tsx` | `admin-changelog-delete` |
| `ChangelogManager.tsx` | `admin-changelog-edit` |
| `ChangelogManager.tsx` | `admin-changelog-form` |
| `ChangelogManager.tsx` | `admin-changelog-new` |
| `ChangelogManager.tsx` | `admin-changelog-page` |
| `ChangelogManager.tsx` | `admin-changelog-save` |
| `ChangelogManager.tsx` | `admin-changelog-slug` |
| `ChangelogManager.tsx` | `admin-changelog-title` |
| `ChangelogManager.tsx` | `admin-changelog-view` |
| `ContentStudioPage.tsx` | `admin-content-page` |
| `ContentStudioPage.tsx` | `admin-content-workflow` |
| `IndexingPanel.tsx` | `admin-indexing-panel` |
| `RoadmapManager.tsx` | `admin-roadmap-cancel` |
| `RoadmapManager.tsx` | `admin-roadmap-category` |
| `RoadmapManager.tsx` | `admin-roadmap-delete` |
| `RoadmapManager.tsx` | `admin-roadmap-description` |
| `RoadmapManager.tsx` | `admin-roadmap-edit` |
| `RoadmapManager.tsx` | `admin-roadmap-estimate` |
| `RoadmapManager.tsx` | `admin-roadmap-filters` |
| `RoadmapManager.tsx` | `admin-roadmap-form` |
| `RoadmapManager.tsx` | `admin-roadmap-move-down` |
| `RoadmapManager.tsx` | `admin-roadmap-move-up` |
| `RoadmapManager.tsx` | `admin-roadmap-new` |
| `RoadmapManager.tsx` | `admin-roadmap-page` |
| `RoadmapManager.tsx` | `admin-roadmap-save` |
| `RoadmapManager.tsx` | `admin-roadmap-sort` |
| `RoadmapManager.tsx` | `admin-roadmap-status` |
| `RoadmapManager.tsx` | `admin-roadmap-title` |

The ones the regression spec actually references are `admin-changelog-new`, `admin-changelog-form`,
`admin-changelog-title`, `admin-changelog-slug`, `admin-changelog-content`, `admin-changelog-save`,
`admin-roadmap-new`, `admin-roadmap-form`, `admin-roadmap-title`, `admin-roadmap-save` and
`admin-roadmap-status` — every one of them belongs to a **form or a page**, not to a row. That is
the useful finding from capturing this first: the migration replaces row markup, and the regression
spec never touches a row id.

## What changed against that contract (2026-08-07)

Every id in the table above survives **except three**, all of them filter controls the shell now
provides:

| Removed | Replaced by | Referenced anywhere? |
|---|---|---|
| `admin-blog-search` | `table-search` | No |
| `admin-blog-tag-<tag>` | `table-facet-tags-<tag>` | No |
| `admin-roadmap-filter-<status>` | `table-facet-status-<status>` | No |

`grep -rn` across `tests/` and `src/` returns nothing for all three, which is why replacing them is
a rename rather than a break. Keeping them would have meant rendering the shell's toolbar *and* a
second set of filter buttons that did the same thing.

`admin-roadmap-filters` is kept as an `sr-only` element pointing at the toolbar, so anything
driving the page by "where are the filters" still finds an answer rather than nothing.

Every **row** id is unchanged — `admin-changelog-row-<id>`, `admin-roadmap-row-<id>`,
`admin-blog-row-<slug>` — they moved from an inline attribute to the shell's required `rowTestId`
prop, which produces the same string.

## Sequence

1. **Capture the current test ids first.** Grep every `data-testid` out of the three files into a
   list before editing anything. That list is the contract for the rest of the plan.
2. **Changelog, then roadmap, then blog library**, one commit each, running the regression suite
   after each.
3. **Record the blog's non-SQL exemption** in plan 04's guard.

Capturing ids before editing means the check is a comparison rather than a memory test.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A `data-testid` changes and the regression suite goes red for markup reasons | **High** if not guarded | Medium — lost debugging time and a distrusted gate | Ids captured up front; the suite runs after each of the three commits, not once at the end; `git diff` checked for changed id literals |
| The blog's loader pagination is mistaken for a missing SQL implementation later | Medium | Low | The non-SQL exemption is explicit in the capability and in plan 04's guard output |
| Status/tag filter behaviour changes subtly | Medium | Medium — these surfaces are how content actually gets managed | Compare the filter chip counts before and after on the same content set |

## Rollback

One commit per surface. The regression suite is the tripwire, and it runs per commit, so a revert
is scoped to a single file.
