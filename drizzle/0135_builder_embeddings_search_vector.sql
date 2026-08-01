-- Custom SQL migration file, put your code below! --
-- A lexical lane over people, reusing the document that already exists.
--
-- Retrieval has three lanes and the human one could not return a person. `solution_component_projections`
-- indexes catalog components, and people are deliberately not catalog components — they live in
-- `canonical_humans`, which plan 43 Phase 3 built as a separate identity system on purpose. So the human lane
-- returned `human_role` components: job postings, which describe demand rather than anyone who can do the
-- work.
--
-- `builder_embeddings.document` is already the canonical text for a person, built by `buildEmbeddingDoc` and
-- kept in step by the write-through indexer. It is what the vector lane embeds. Generating a `tsvector` from
-- it gives the lexical lane the same corpus, which means the two lanes rank the same text — the premise rank
-- fusion depends on. A second projection table for people would be a second document to keep in step with the
-- first, and the first is already correct.
--
-- 'english' matches `solution_component_projections.search_vector` deliberately. Two configurations in one
-- fused query would mean "position 3" was computed differently on either side.

ALTER TABLE "builder_embeddings"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "document")) STORED;

CREATE INDEX "builder_embeddings_search_idx" ON "builder_embeddings" USING gin ("search_vector");

-- The human lane's join: identities that belong to a canonical human, via their active links. Partial,
-- because a withdrawn or merely proposed link must never contribute a person to a recommendation — the same
-- narrowing `findCanonicalHumanForAccount` applies, expressed as an index so the lane's query can use it.
CREATE INDEX "human_source_links_active_lookup_idx"
  ON "human_source_links" ("builder_identity_id", "canonical_human_id")
  WHERE "valid_until" IS NULL AND "review_state" IN ('auto_approved', 'approved');
