import { registerProviderCapability } from '../capability'

/**
 * Keyword search: a fan-out to thirteen third-party APIs.
 *
 * A `ProviderCapability` rather than a `TableCapability`, because there is no table. Nothing here
 * becomes SQL, so there is no column allowlist to enforce and no index for plan 04's guard to look
 * for — see `ProviderCapability`'s own comment for why that is a different shape rather than a
 * `TableCapability` with its fields left empty.
 *
 * **`sorts` is empty, and that is the finding rather than an omission.** The surface used to offer
 * "Best match", "Most recent" and "Most followers", and all three re-sorted the rows the browser
 * happened to hold. With up to `sources × 30` rows in one response that looked convincing and was
 * never true: "most followers" meant "the most-followed of the ones already fetched". A federation
 * of paged upstreams cannot sort globally without exhausting every one of them, so the honest set
 * of sorts a client may pick is empty and the control is gone. Relevance — the fused rank the
 * connectors' own orderings produce — is the only ordering, and it is not a choice.
 *
 * `filters` names the three the backend does honour. They live in the search page's own filter
 * panel rather than the table toolbar, because changing one re-runs the federation from page one:
 * they are query inputs, not a view over a set already fetched.
 */
export const searchBuildersCapability = registerProviderCapability({
  table: 'search_builders',
  sorts: [],
  filters: ['sources', 'language', 'country'],
  countable: false,
  reason:
    'Federated third-party search. No SQL is emitted, so there is no column allowlist to enforce; '
    + 'the query surface is each connector\'s own API and the response is bounded by a signed '
    + 'provider continuation instead of a keyset cursor.',
})

/**
 * The local semantic leg — a real SQL keyset over `builder_embeddings`, and still not a
 * `TableCapability`.
 *
 * Its ordering is a distance computed against a query vector, not a stored column, so `sortable`
 * has nothing to name and `capability-index.ts` would look for a b-tree over a column that does not
 * exist. The index that does back it is `builder_embeddings_hnsw_idx`, which plan 04's guard has no
 * vocabulary for; the EXPLAIN-based regression test in
 * `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts` is what proves it is used.
 *
 * `countable` is false for a reason worth stating: the total *could* be computed, but only by
 * computing a distance for every embedded row, since the relevance threshold is a cut on a derived
 * value. A number that expensive is not a count the UI should be tempted to show.
 */
export const searchSemanticCapability = registerProviderCapability({
  table: 'search_semantic',
  sorts: [],
  filters: ['sources', 'language', 'country'],
  countable: false,
  reason:
    'Vector similarity over builder_embeddings. The ordering is an expression against the query '
    + 'vector rather than a column, so no column allowlist and no b-tree index guard applies; '
    + 'the HNSW index behind it is proven by an EXPLAIN regression test instead.',
})
