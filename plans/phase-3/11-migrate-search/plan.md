# Plan — migrate search onto the table shell

> **Status**: `pending`
> **Depends on**: [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: One UI component, two routes, the federation, and the pgvector repository.
> The SQL keyset engine applies only to the local semantic leg.

## Sequence

1. Record deterministic keyword and semantic first-page fixtures plus source-health metadata.
2. Define and adversarially test the signed provider-continuation contract.
3. Page the local semantic leg by `(distance, source, source_id)` and preserve hybrid fallback.
4. Adapt both response shapes to `PageResult` (`total: null` where unknowable).
5. Move the result collection onto `DataTable`/virtualization and remove partial client sorting.
6. Exercise query/mode/filter changes, degraded sources, tracking and long scroll in the browser.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Relevance changes subtly | Medium | High | Seeded ordered fixtures captured before edits and compared id-for-id |
| A SQL cursor is falsely imposed on external APIs | High in the old draft | High | Separate signed provider continuation with explicit best-effort consistency |
| Source-health or fallback metadata disappears in a generic adapter | Medium | High | Metadata is part of the adapter contract and covered by route/e2e tests |
| Cursor survives a changed query or enabled-source set | Medium | High | Signature binds normalized query, mode, filters, scope and source snapshot |
| UI still sorts only loaded rows | Medium | High | Non-relevance sort is unavailable until backend completeness is real; grep plus e2e gate |

## Rollback

The two server contracts and UI adapter land in separate commits. Reverting the UI restores the old
consumer; reverting a continuation keeps the preceding bounded response contract intact. No schema
migration is required unless measurements justify persistent search sessions, which is out of scope.
