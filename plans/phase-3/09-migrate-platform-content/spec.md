# Specification — migrate the platform content managers

> **Status**: `implemented`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `src/modules/admin/content/ChangelogManager.tsx`, `RoadmapManager.tsx` and
> `BlogLibrary.tsx` render row lists with their own filters and status controls.
> `tests/regression/test-status-and-trust.mjs` **drives the changelog and roadmap managers by
> `data-testid`**. `BlogLibrary` reads the filesystem through `src/shared/lib/blog.ts`, not the
> database. Content is file-managed with deterministic ids (`content-changelog-*`,
> `content-roadmap-*`) synced by `scripts/db/sync-platform-content.ts`.

## Problem

These three are the newest surfaces and already the most table-like — tag filters, status filters,
"in git" badges — which makes them the clearest demonstration that the same behaviour was
hand-built a third time.

## Goal

All three on the shell, with **not one `data-testid` changed**.

## Non-goals

- **Changing the file-as-source-of-truth model.** Content lives in `content/` and syncs to the
  database; this plan changes how it is listed, not where it lives.
- **Making `BlogLibrary` writable.** It is read-only by design.
- **Moving blog pagination into SQL.** Posts come from the filesystem.

## The test-id constraint

This is the plan's defining risk. `tests/regression/test-status-and-trust.mjs` operates the
changelog and roadmap managers by `data-testid`, and a green regression suite going red for
markup reasons is the worst outcome of this whole phase: it costs debugging time and teaches
people to distrust the gate.

So `rowTestId` must reproduce today's ids exactly, and the verification is mechanical: run the
regression suite before and after, and confirm `git diff` shows no changed `data-testid` string
literal.

## The file-backed table

`BlogLibrary` reads `content/posts/` via `src/shared/lib/blog.ts`. There is no SQL, so:

- Its capability is marked **non-SQL** and is exempt from plan 04's index guard — explicitly, with
  the exemption recorded, not by a name pattern.
- Pagination happens over the parsed list in the loader, behind the same `PageResult` shape, so the
  shell cannot tell the difference.
- Sorting and filtering run in the loader over the full parsed set, which is *correct* because the
  loader holds the complete set — the property that makes client-side sorting wrong elsewhere.

This is the one place in the phase where sorting outside SQL is legitimate, and it is legitimate
for a stated reason rather than by omission.

## Success metrics

- `node tests/regression/test-status-and-trust.mjs` green before and after each commit.
- `git diff` shows no modified `data-testid` value.
- All three in the shared e2e parameter list and passing.
- The blog capability's non-SQL exemption is visible in plan 04's guard output, not silent.

## Resolved edge cases

- **The "in git" badge** on `content-*`-prefixed rows. A cell renderer, not a shell feature.
- **23 changelog entries and 32 roadmap items** — both under one page. Page one is the last page.
- **A roadmap item's status control.** Stays a per-row action; the shell does not learn about
  roadmap statuses.
- **Sorting the blog library by date.** Runs in the loader over the complete parsed list, which is
  correct because it is complete.
