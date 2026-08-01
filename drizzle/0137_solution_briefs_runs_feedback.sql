-- Saved briefs, runs, routes, and feedback (plan 43 Phase 8, "Persist explicit briefs, runs, and feedback").
--
-- The first tenant-private tables in the Solutions module. Everything before this — components, versions,
-- capabilities, evidence, edges, projections — is global-public: "this model can translate" is a fact about a
-- public thing and no organization owns it. What an organization *asked for*, and what it was *told*, is
-- different, and these four tables are scoped, RLS'd, and granted accordingly.
--
-- ## Immutable means it cannot be changed, not that it cannot be erased
--
-- `solution_runs` and `solution_run_routes` get SELECT, INSERT and DELETE but **no UPDATE grant**. A stored
-- recommendation is what an organization was told on a given day; a version of it that could be edited
-- afterwards would be worthless as a record and dangerous in a dispute. Deletion stays available because
-- retention and erasure need it, and because "you may never delete your own data" is not a property anyone
-- asked for.
--
-- `solution_briefs` and `solution_run_feedback` do get UPDATE: a saved brief is a working document a user
-- renames and edits, and feedback is an opinion someone is allowed to change. Editing a brief cannot rewrite
-- history, because a run stores its own `brief_snapshot`.
--
-- ## No worker, platform, or capability grants
--
-- Nothing background-processes these tables, no admin surface reads them, and no public capability token
-- reaches them. Granting a role "just in case" is how a table ends up readable by a path nobody reviewed, so
-- each of the four is granted to `builderhunt_app` only. A future worker (retention sweeps, evaluation
-- exports) adds its own grant in its own migration, with its own reason.

CREATE TABLE "solution_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"title" text NOT NULL,
	"brief" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solution_briefs_title_length_check" CHECK (char_length("solution_briefs"."title") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "solution_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"brief_id" text,
	"created_by_user_id" text,
	"brief_snapshot" jsonb NOT NULL,
	"ranking_mode" text NOT NULL,
	"retrieval_query_hash" text NOT NULL,
	"composition_hash" text NOT NULL,
	"composer_version" text NOT NULL,
	"interpret_prompt_version" text,
	"explain_prompt_version" text,
	"component_version_ids" text[] DEFAULT '{}' NOT NULL,
	"evidence_ids" text[] DEFAULT '{}' NOT NULL,
	"source_statuses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credit_reservation_id" text,
	"credit_settled_units" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solution_runs_ranking_mode_check" CHECK ("solution_runs"."ranking_mode" in ('recommended', 'maximum_quality', 'lower_cost_time')),
	CONSTRAINT "solution_runs_settled_units_check" CHECK ("solution_runs"."credit_settled_units" is null or "solution_runs"."credit_settled_units" >= 0),
	CONSTRAINT "solution_runs_settlement_needs_reservation_check" CHECK ("solution_runs"."credit_settled_units" is null or "solution_runs"."credit_reservation_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "solution_run_routes" (
	"run_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"route_type" text NOT NULL,
	"route" jsonb NOT NULL,
	"status" text NOT NULL,
	"explanation_provenance" text NOT NULL,
	"explanation_fallback_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solution_run_routes_run_id_route_type_pk" PRIMARY KEY("run_id","route_type"),
	CONSTRAINT "solution_run_routes_type_check" CHECK ("solution_run_routes"."route_type" in ('human', 'ai', 'hybrid')),
	CONSTRAINT "solution_run_routes_status_check" CHECK ("solution_run_routes"."status" in ('recommended', 'available', 'unavailable')),
	CONSTRAINT "solution_run_routes_provenance_check" CHECK ("solution_run_routes"."explanation_provenance" in ('model', 'deterministic')),
	CONSTRAINT "solution_run_routes_fallback_reason_check" CHECK (("solution_run_routes"."explanation_provenance" = 'model' and "solution_run_routes"."explanation_fallback_reason" is null)
        or ("solution_run_routes"."explanation_provenance" = 'deterministic' and "solution_run_routes"."explanation_fallback_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "solution_run_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"route_type" text NOT NULL,
	"created_by_user_id" text,
	"chosen" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solution_run_feedback_route_type_check" CHECK ("solution_run_feedback"."route_type" in ('human', 'ai', 'hybrid')),
	CONSTRAINT "solution_run_feedback_reason_length_check" CHECK ("solution_run_feedback"."reason" is null or char_length("solution_run_feedback"."reason") <= 500)
);
--> statement-breakpoint

ALTER TABLE "solution_briefs" ADD CONSTRAINT "solution_briefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_briefs" ADD CONSTRAINT "solution_briefs_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_runs" ADD CONSTRAINT "solution_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_runs" ADD CONSTRAINT "solution_runs_brief_id_solution_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."solution_briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_runs" ADD CONSTRAINT "solution_runs_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_run_routes" ADD CONSTRAINT "solution_run_routes_run_id_solution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."solution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_run_routes" ADD CONSTRAINT "solution_run_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_run_feedback" ADD CONSTRAINT "solution_run_feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_run_feedback" ADD CONSTRAINT "solution_run_feedback_run_id_solution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."solution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solution_run_feedback" ADD CONSTRAINT "solution_run_feedback_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "solution_briefs_org_idx" ON "solution_briefs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "solution_runs_org_idx" ON "solution_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "solution_runs_brief_idx" ON "solution_runs" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "solution_run_routes_org_idx" ON "solution_run_routes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "solution_run_feedback_one_per_user_route" ON "solution_run_feedback" USING btree ("run_id","route_type","created_by_user_id");--> statement-breakpoint
CREATE INDEX "solution_run_feedback_org_idx" ON "solution_run_feedback" USING btree ("organization_id","created_at");--> statement-breakpoint

-- RLS. Every policy is the same shape the rest of the tenant tables use: the row's `organization_id` must
-- equal the transaction's `app.organization_id`, which `withTenantContext` sets and nothing else does.
-- FORCE, so a table owner connecting directly is subject to it too.

ALTER TABLE "solution_briefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "solution_briefs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "solution_briefs_app_select" ON "solution_briefs"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_briefs_app_insert" ON "solution_briefs"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_briefs_app_update" ON "solution_briefs"
  FOR UPDATE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text))
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_briefs_app_delete" ON "solution_briefs"
  FOR DELETE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "solution_briefs" TO "builderhunt_app";--> statement-breakpoint

ALTER TABLE "solution_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "solution_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "solution_runs_app_select" ON "solution_runs"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_runs_app_insert" ON "solution_runs"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_runs_app_delete" ON "solution_runs"
  FOR DELETE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
-- No UPDATE. See the header: a stored recommendation that could be edited afterwards is worthless as a record.
GRANT SELECT, INSERT, DELETE ON "solution_runs" TO "builderhunt_app";--> statement-breakpoint

ALTER TABLE "solution_run_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "solution_run_routes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "solution_run_routes_app_select" ON "solution_run_routes"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_run_routes_app_insert" ON "solution_run_routes"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_run_routes_app_delete" ON "solution_run_routes"
  FOR DELETE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "solution_run_routes" TO "builderhunt_app";--> statement-breakpoint

ALTER TABLE "solution_run_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "solution_run_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "solution_run_feedback_app_select" ON "solution_run_feedback"
  FOR SELECT TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_run_feedback_app_insert" ON "solution_run_feedback"
  FOR INSERT TO "builderhunt_app"
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_run_feedback_app_update" ON "solution_run_feedback"
  FOR UPDATE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text))
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
CREATE POLICY "solution_run_feedback_app_delete" ON "solution_run_feedback"
  FOR DELETE TO "builderhunt_app"
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), ''::text));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "solution_run_feedback" TO "builderhunt_app";
