# Specification — migrate search onto the table shell

> **Status**: `pending`
> **Depends on**: [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `SearchPage.tsx` is 1,666 lines and appends pages without virtualization.
> Keyword search fans out to third-party APIs in `src/lib/search.ts`; it is not a SQL table and
> cannot use `buildKeysetPage`. Semantic search has a local pgvector leg plus a federated fallback.

## Problem

Search sorts a partial, infinitely growing client array and presents it as a complete ranking. The
DOM grows without a bound. The earlier plan draft proposed passing both endpoints through the SQL
keyset builder, which is impossible for federated APIs and would erase source-health semantics.

## Goal

Render keyword and semantic search through the shared shell and virtualizer, move every available
sort/filter to the backend that owns the full result set, and preserve the exact current relevance
ordering and degraded-source reporting.

## Backend contracts

### Federated keyword search

The federation remains provider-backed. It returns at most `TABLE_PAGE_SIZE` rows and an opaque,
signed continuation bound to the normalized query, filters, enabled-source snapshot and access
scope. The continuation contains only bounded per-source continuation/page state; it never contains
client-supplied column names. Sources that expose only numeric pages remain best-effort under
concurrent upstream changes, and the response says `consistency: 'provider-best-effort'` rather than
claiming keyset stability.

Because the federation cannot know the total without exhausting every upstream, it returns
`total: null`. It supports `relevance` only. A header for followers/date is not sortable in keyword
mode unless the backend first materializes the complete set; sorting a loaded prefix is forbidden.

### Semantic search

The local pgvector leg pages in SQL by total order `(distance, source, source_id)` and uses a signed
public/tenant cursor bound to the query-vector hash and filters. It can report an exact total only if
measured cheaply; otherwise `total: null` is honest. The hybrid/federated fallback uses the keyword
continuation contract and keeps its mode explicit.

Semantic relevance stays the default. A secondary column sort is offered only on a materialized
bounded candidate set whose completeness is known; otherwise it is hidden, not performed on one
page.

## UI scope

Extract the result collection and shell adapter from `SearchPage.tsx`; leave the filter panel,
source toggles and semantic-mode controls in place. Changing query, mode, source or filter clears the
continuation and loaded rows before requesting page one. Preserve source health/degraded messaging,
tracked state, cards, actions and all current test ids.

## Success metrics

- Keyword and semantic first-page ids match recorded seeded fixtures exactly.
- No client-side sort touches the loaded result array.
- Every response holds at most `TABLE_PAGE_SIZE` rows and uses the correct continuation contract.
- 500 loaded fixture rows keep the rendered DOM window bounded.
- Changing any query control cannot reuse an old cursor.
- Existing search e2e, source-health, fallback, tracking and entitlement tests stay green.

## Non-goals

- Changing scoring, fusion, semantic thresholds, provider selection or source-health behavior.
- Claiming keyset consistency for third-party APIs that do not provide it.
- Fabricating a total count.
- Refactoring the entire `SearchPage.tsx`.

## Resolved edge cases

- A provider fails on page two: keep loaded rows, show its failed status, and allow retry.
- Semantic falls back mid-query: mode and continuation kind change together; the old cursor is invalid.
- An enabled source is disabled between pages: the source snapshot mismatch rejects the old cursor
  and restarts at page one, so cached rows from the disabled source are not served.
- Zero results with failed sources is a degraded empty state, not proof that nobody matched.
