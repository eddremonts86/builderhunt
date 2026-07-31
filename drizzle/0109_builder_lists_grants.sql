-- Plan 28 (shared-resources) — RLS + grants for builder_lists / builder_list_items.
--
-- Bug found by the 2026-07-31 phase-1 plan-vs-reality audit: 0105_builder_lists.sql created both
-- tables with no RLS and no GRANT to any role at all. Every real request from the running app
-- (builderhunt_app, NOBYPASSRLS) failed with `permission denied for table builder_lists` — the
-- "Add to shortlist" feature was completely broken. The sibling table `feed_capabilities` had the
-- identical defect and got patched two migrations later (0107) while writing an unrelated table's
-- grants; nobody circled back to these two.
--
-- Scope matches actual usage (`src/shared/lib/repositories/builder-lists.ts`): every read/write goes
-- through `withTenantContext` under a `TenantTransaction`, scoped by `organization_id` alone — the
-- private-vs-organization visibility split is enforced in application code (`can()`), the same way
-- `organization_builders` already does it, not by a second RLS dimension. No worker or platform role
-- ever touches either table, and nothing in the codebase issues an UPDATE on either — grants are
-- SELECT/INSERT/DELETE only, matching what the repository actually does.

ALTER TABLE "builder_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "builder_lists" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "builder_lists_app_select" ON "builder_lists"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "builder_lists_app_insert" ON "builder_lists"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "builder_lists_app_delete" ON "builder_lists"
  FOR DELETE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "builder_lists" TO "builderhunt_app";--> statement-breakpoint

ALTER TABLE "builder_list_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "builder_list_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "builder_list_items_app_select" ON "builder_list_items"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "builder_list_items_app_insert" ON "builder_list_items"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "builder_list_items_app_delete" ON "builder_list_items"
  FOR DELETE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "builder_list_items" TO "builderhunt_app";
