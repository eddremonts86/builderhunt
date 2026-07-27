# Specification — migrate search onto the shell

> **Status**: `pending`
> **Depends on**: [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `src/modules/search/components/SearchPage.tsx` is 1,731 lines — the largest component in the app. It is the only surface with existing infinite scroll (`SearchPage.tsx:399-449`, page-counting with `page`/`perPage`/`hasMore` and an `IntersectionObserver` at 200px `rootMargin`), the only one with client-side sorting (`sortBy` at line 157, applied at 496-504), and it appends into a growing array at line 423 with no virtualization. It has two backends: `/api/search/builders` and `/api/search/semantic`.

## Problem

Search is where the current approach is most visibly strained: a client-side sort over an
infinitely-scrolled partial list, which sorts only what has loaded and presents the result as a
ranking. It is also the surface where virtualization matters most, because it is the one people
scroll for minutes.

## Goal

Search on the shell, with pagination and sorting server-side, and the semantic ranking preserved
exactly.

## Non-goals

- **Changing relevance or scoring.** The semantic pipeline's ranking is the product; this plan does
  not touch how results are ordered by relevance.
- **Merging the two backends.** Keyword and semantic stay separate endpoints.
- **Splitting the 1,731-line component.** Tempting and out of scope. Extracting the result list is
  in scope; refactoring the filter panel, source toggles and semantic mode switch is not.

## Semantic ranking as a pass-through

The core design question. Semantic search produces a **ranked set of ids** from a vector query;
that ranking cannot be expressed as an `ORDER BY` over a column, so it cannot be a `TableQuery`
sort.

The ranked id set is therefore passed to `buildKeysetPage` as an **opaque pre-filter**, and the
capability declares a relevance sort that means "preserve the order of the supplied id set". The
keyset tiebreaker still applies within equal relevance so pages remain stable.

Attempting to translate semantic relevance into the generic sort vocabulary would either lose the
ranking or leak vector internals into the URL. Neither is acceptable, so it stays a pass-through.

## Success metrics

- `grep -n 'perPage\|hasMore\|IntersectionObserver' src/modules/search/components/SearchPage.tsx`
  returns nothing.
- The client-side `sortBy` block (currently lines 157 and 496-504) is gone; sorting is a
  `TableQuery`.
- Semantic and keyword modes both paginate, and the first page of semantic results is **identical**
  to today's for the same query — asserted against a recorded fixture, not eyeballed.
- Scrolling a large result set holds DOM node count flat (the virtualizer from plan 06).
- Existing search e2e specs green.

## Resolved edge cases

- **Switching from semantic to keyword mid-scroll.** A new query, so the cursor is dropped and the
  list refetches from page one.
- **Sorting semantic results by followers.** Allowed: the pre-filter narrows to the ranked set, and
  the requested column orders within it. The UI must not imply this is still relevance order.
- **A ranked id set larger than one page.** The pre-filter carries the whole set; the keyset
  predicate walks it. If the set is large enough that passing it becomes the bottleneck, record that
  rather than silently truncating.
- **Zero semantic results.** The empty state, not the filtered-empty state — the query matched
  nothing, no filter excluded anything.
