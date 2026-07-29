-- Plan 28 (shared-resources) task 9: replace raw saved-query RSS access
-- with a public feed capability record.
--
-- Why a separate table instead of an HMAC on the saved query id:
--   1. The HMAC approach embedded the raw queryId in the URL. Anyone
--      with a leaked feed link could read the queryId and try it
--      against other internal endpoints that key by queryId.
--   2. There was no way to revoke or rotate a leaked token without
--      changing the secret (which invalidates every other feed).
--   3. There was no expiry, no per-capability audit, no way to know
--      which feed a token belonged to once the underlying query was
--      deleted.
--
-- The capability id is the path param. The token in the query string
-- is checked against capability_hash. The query_id stays inside the
-- table and is never exposed to the public surface. When the
-- underlying saved query is deleted, the FK's ON DELETE CASCADE
-- drops the capability too, so a deleted query is unreachable
-- through any token.
--
-- The unique constraint on capability_hash makes the token check
-- O(1) and stops an attacker from enumerating; it also means the
-- column is the only thing standing between an attacker and a feed,
-- so it has a hash size >= 32 bytes (base64url'd to >= 43 chars).

CREATE TABLE IF NOT EXISTS "feed_capabilities" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL,
  "query_id" text NOT NULL,
  "capability_hash" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp without time zone,
  "revoked_at" timestamp without time zone,
  CONSTRAINT "feed_capabilities_id_unique" UNIQUE ("id"),
  CONSTRAINT "feed_capabilities_capability_hash_unique" UNIQUE ("capability_hash")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_capabilities_org_idx" ON "feed_capabilities" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feed_capabilities_query_idx" ON "feed_capabilities" USING btree ("query_id");--> statement-breakpoint
ALTER TABLE "feed_capabilities" ADD CONSTRAINT "feed_capabilities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_capabilities" ADD CONSTRAINT "feed_capabilities_query_id_saved_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."saved_queries"("id") ON DELETE cascade ON UPDATE no action;
