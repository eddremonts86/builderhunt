CREATE TABLE "onboarding_selected_builders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"user_id" text NOT NULL,
	"builder_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_selected_builders" ADD CONSTRAINT "onboarding_selected_builders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_selected_builders" ADD CONSTRAINT "onboarding_selected_builders_user_id_onboarding_progress_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."onboarding_progress"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_selected_builders" ADD CONSTRAINT "onboarding_selected_builders_organization_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."onboarding_progress"("organization_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_selected_builders_user_builder_unique" ON "onboarding_selected_builders" USING btree ("user_id","builder_ref");--> statement-breakpoint
CREATE INDEX "onboarding_selected_builders_organization_idx" ON "onboarding_selected_builders" USING btree ("organization_id");--> statement-breakpoint

-- Same RLS/grant shape as drizzle/0008_tenant_rls.sql's product-table loop —
-- this table joined the tenant-private set after that migration, so it gets
-- its own gate here instead of a retroactive edit to an applied migration.
ALTER TABLE onboarding_selected_builders ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_selected_builders FORCE ROW LEVEL SECURITY;

CREATE POLICY onboarding_selected_builders_app_select ON onboarding_selected_builders
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY onboarding_selected_builders_app_insert ON onboarding_selected_builders
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY onboarding_selected_builders_app_update ON onboarding_selected_builders
  FOR UPDATE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY onboarding_selected_builders_app_delete ON onboarding_selected_builders
  FOR DELETE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

REVOKE ALL ON TABLE onboarding_selected_builders FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE onboarding_selected_builders TO builderhunt_app;