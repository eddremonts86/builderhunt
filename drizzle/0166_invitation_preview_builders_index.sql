-- The index behind the invitation review page's three-builder preview.
--
-- `readInvitationPreviewBuilders` reads `builder_identities` with `kind = 'person'` and a non-null
-- avatar, ordered by `last_seen_at DESC, id DESC`, limited to 3. Phase 3's sixth principle is that a
-- column is only sortable when an index backs it — enforced by a test and an EXPLAIN assertion rather
-- than by discipline — and `builder_identities_kind_idx` (drizzle/0133) covers only the equality.
-- Without this, the three rows come from a sort of every person in the table.
--
-- `id DESC` is in the index, not decoration: `last_seen_at` is not unique, because a discovery run
-- stamps a whole batch with the same value. Without the tiebreaker the same page can return a
-- different three rows on a refresh, and the `LIMIT 3` boundary can land inside a tie.
--
-- Partial on `avatar_url IS NOT NULL` because the query always carries that predicate — a card of grey
-- placeholders reads as broken rather than as sparse — so the rows the index does not contain are rows
-- this read can never want.
CREATE INDEX IF NOT EXISTS "builder_identities_person_recent_idx"
  ON "builder_identities" ("kind", "last_seen_at" DESC, "id" DESC)
  WHERE "avatar_url" IS NOT NULL;
