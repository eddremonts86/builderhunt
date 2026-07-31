-- Wave 2 (plans/UI/tasks.md) "Shortlist metadata and visibility editing" adds the first UPDATE
-- ever issued against builder_lists (rename/description/visibility PATCH). 0109_builder_lists_grants.sql
-- granted only SELECT/INSERT/DELETE to builderhunt_app because nothing in the codebase updated this
-- table at the time — that comment's premise is no longer true, so the grant and its RLS policy
-- need to catch up, not be worked around.
CREATE POLICY "builder_lists_app_update" ON "builder_lists"
  FOR UPDATE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text))
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
GRANT UPDATE ON "builder_lists" TO "builderhunt_app";
