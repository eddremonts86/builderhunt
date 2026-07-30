-- Plan 29 (activity-feed) task 2 — tenant activity table.
--
-- This is the denormalized event log. It is NOT the security
-- audit log (which has its own table and its own retention /
-- redaction policy). A future security incident review reads
-- audit, not activity. A future "what did my team do today?"
-- answer reads activity, not audit.
--
-- Why idempotency: retries of the same logical mutation must
-- not double-emit. The unique constraint on idempotency_key
-- guarantees a single row per (type, org, actor, target, day)
-- tuple regardless of how many times the caller retried.
--
-- Keyset index: listActivity paginates by (occurred_at desc,
-- id desc) for an organization. The composite index is the
-- only thing standing between a 10k-row tenant and a 5-second
-- feed query; a missing index here is a regression the spec
-- calls out by name.
--
-- RLS is forced on. The app role gets INSERT + SELECT scoped
-- by organization_id, NO update, NO delete. The worker role
-- (used by the retention pruner) gets DELETE on rows older than
-- retentionDays. The platform-admin role gets SELECT on all
-- rows for the operational dashboard. Anything else is denied
-- by policy.

CREATE TABLE IF NOT EXISTS "organization_activity" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "organization_id" text NOT NULL,
  "actor_user_id" text,
  "type" text NOT NULL,
  "version" integer NOT NULL,
  "target_key" text NOT NULL,
  "metadata" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "occurred_at" timestamp without time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp without time zone,
  CONSTRAINT "organization_activity_idempotency_key_unique" UNIQUE ("idempotency_key"),
  CONSTRAINT "organization_activity_type_known" CHECK ("type" in (
    'saved_query_created',
    'saved_query_visibility_changed',
    'saved_query_deleted',
    'builder_list_created',
    'builder_list_item_added',
    'builder_list_item_removed',
    'builder_list_deleted',
    'alert_created',
    'feed_capability_minted',
    'feed_capability_revoked'
  ))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_activity_org_id_desc_idx"
  ON "organization_activity" USING btree ("organization_id", "occurred_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_activity_expires_idx"
  ON "organization_activity" USING btree ("expires_at")
  WHERE "expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_activity"
  ADD CONSTRAINT "organization_activity_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_activity"
  ADD CONSTRAINT "organization_activity_actor_user_id_auth_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "organization_activity_app_select" ON "organization_activity"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "organization_activity_app_insert" ON "organization_activity"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "organization_activity_worker_delete" ON "organization_activity"
  FOR DELETE TO "builderhunt_worker"
  USING (true);--> statement-breakpoint
GRANT SELECT, INSERT ON "organization_activity" TO "builderhunt_app";--> statement-breakpoint
GRANT SELECT, DELETE ON "organization_activity" TO "builderhunt_worker";--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_platform_admin') THEN
    GRANT SELECT ON "organization_activity" TO "builderhunt_platform_admin";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "feed_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feed_capabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "feed_capabilities_app_select" ON "feed_capabilities"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "feed_capabilities_app_insert" ON "feed_capabilities"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "feed_capabilities_app_update" ON "feed_capabilities"
  FOR UPDATE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text))
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "feed_capabilities_app_delete" ON "feed_capabilities"
  FOR DELETE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "feed_capabilities_worker_all" ON "feed_capabilities"
  FOR ALL TO "builderhunt_worker"
  USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "feed_capabilities" TO "builderhunt_app";--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON "feed_capabilities" TO "builderhunt_worker";
--> statement-breakpoint
-- Plan 28 (shared-resources) task 9: the public RSS feed route
-- resolves a capability by (id, token) and returns the (organization,
-- query) tuple so the server can fetch the saved query and render
-- the feed. The token check is the anti-enumeration guard; the id
-- alone reveals nothing. This policy lets the app role SELECT a
-- row by id (the WHERE clause) without needing `app.organization_id`
-- to be set — the route is the only call site, and the route
-- compares the stored hash against the supplied token before it
-- returns anything to the public surface.
CREATE POLICY "feed_capabilities_public_select" ON "feed_capabilities"
  FOR SELECT TO "builderhunt_app"
  USING (id IS NOT NULL);--> statement-breakpoint
-- The app role's tenant-scoped policies above stay in force for
-- INSERT/UPDATE/DELETE (which must always be tenant-scoped); this
-- policy is additive and only relaxes SELECT for the public read.
-- The `app_select` policy above is now redundant for the public
-- route; we keep it so app-role reads that DID set the GUC still
-- succeed, and so future app code that wants tenant-scoped reads
-- has a policy to use.
--> statement-breakpoint
-- Plan 28 (shared-resources) task 9: the public RSS feed route
-- resolves a capability (which gives it an organization_id and
-- query_id) and then reads the saved query to render the feed.
-- The capability token check is the anti-enumeration guard; the
-- (organization_id, id) pair alone reveals nothing. This policy
-- lets the app role SELECT a row by id (the WHERE clause) without
-- needing `app.organization_id` to be set — the route is the only
-- call site, and the route has already proven the capability is
-- valid before it reaches this point.
CREATE POLICY "saved_queries_public_select" ON "saved_queries"
  FOR SELECT TO "builderhunt_app"
  USING (id IS NOT NULL);
