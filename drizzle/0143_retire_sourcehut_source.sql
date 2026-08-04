-- Custom SQL migration file, put your code below! --
--
-- Retires SourceHut (plans/phase-1/11-sourcehut-integration). Not a technical limitation — the operator's own
-- written policy excludes this product's use.
--
-- `https://git.sr.ht/robots.txt`, read 2026-08-04 and identical at meta.sr.ht, opens with a prose policy rather
-- than only directives: allowed are search-engine indexers and archival services; **disallowed are marketing or
-- SEO crawlers and "anything used to feed a machine learning model."** BuilderHunt indexes profiles into
-- `builder_embeddings` (pgvector) and feeds AI ranking and grounded explanation. It is the case that sentence
-- names, and because it is a statement about the *use*, a `SOURCEHUT_TOKEN` does not resolve it — the token would
-- only record that a person accepted terms while the use stayed excluded.
--
-- The connector never worked anyway: `users(search:)` does not exist on meta.sr.ht and git.sr.ht offers no
-- keyword search over repositories, so `searchSourceHut` had always degraded to `[]` — indistinguishable from
-- "no token configured", which is what hid it. See the plan for the full API findings.
--
-- ## Why this UPDATEs instead of DELETEing the row
--
-- `search_sources` already had a retirement mechanism and it is better than removal:
--
--   * `CHECK ("enabled" = false OR "connector_implemented" = true)` — with no connector, the database itself
--     refuses to let the source be enabled again.
--   * `setSearchSourceEnabled` (`repositories/search-sources.ts`) returns `no_connector` rather than a constraint
--     error, so the admin toggle explains itself instead of failing opaquely.
--   * `resolveRequestedSources` refuses any key that is not enabled, so the search fan-out stops offering it
--     without any code needing to know the reason.
--
-- Deleting the row would lose the record that this source was evaluated and why. Keeping it disabled means the
-- register still answers "what about SourceHut?" — and reversing this is one migration flipping both booleans
-- back, once a connector exists that sr.ht's policy permits.
UPDATE "search_sources"
SET "enabled" = false,
    "connector_implemented" = false,
    "register_notes" = 'Retired 2026-08-04. sr.ht''s robots.txt prose policy disallows "anything used to feed a '
      || 'machine learning model", which is what this product does — so no access token resolves it. The API also '
      || 'offers no user or repository search (meta.sr.ht has no users(search:) field; git.sr.ht reaches '
      || 'repositories only through a known username), so the connector had never returned a result. Reverse by '
      || 'setting connector_implemented = true once a connector exists that the policy permits.'
WHERE "key" = 'sourcehut';
