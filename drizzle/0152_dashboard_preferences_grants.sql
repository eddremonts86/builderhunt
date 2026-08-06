-- Row-level security and grants for `dashboard_preferences`.
--
-- Separate from the generated `0151`, following the convention this repository already established
-- in `0109_builder_lists_grants.sql`: drizzle-kit emits tables, never policies or grants, so a table
-- whose RLS lived in a generated file would lose it the next time that file was regenerated. Losing
-- RLS on a tenant table is a cross-tenant read, not a cosmetic regression.
--
-- The policy shape is the same one every tenant table here uses: the app role sees only rows whose
-- organization matches the session's `app.organization_id`, which `withTenantContext` sets.
ALTER TABLE "dashboard_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "dashboard_preferences_app_select" ON "dashboard_preferences"
	FOR SELECT TO "builderhunt_app"
	USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), ''));--> statement-breakpoint
CREATE POLICY "dashboard_preferences_app_insert" ON "dashboard_preferences"
	FOR INSERT TO "builderhunt_app"
	WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), ''));--> statement-breakpoint
CREATE POLICY "dashboard_preferences_app_update" ON "dashboard_preferences"
	FOR UPDATE TO "builderhunt_app"
	USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), ''));--> statement-breakpoint

-- SELECT, INSERT and UPDATE — the write is an upsert, and this is one of the few tenant tables the
-- app role legitimately writes on a user's own behalf.
--
-- **No DELETE grant, and no delete policy.** Nothing in the product deletes a preference row; a
-- "reset my layout" is an update to the defaults. Granting a privilege because it might one day be
-- wanted is how `builderhunt_app` would end up able to delete rows no code path ever needs to — and
-- this repository has already paid for the opposite mistake, in an enrichment helper that took the
-- app transaction to run a delete the grant refused with 42501.
GRANT SELECT, INSERT, UPDATE ON "dashboard_preferences" TO "builderhunt_app";
