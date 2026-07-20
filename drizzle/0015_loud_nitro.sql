CREATE TABLE "sourcing_sprints" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"name" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"variants" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"quota" integer DEFAULT 200 NOT NULL,
	"cursor" jsonb DEFAULT '{"variantIndex":0,"page":1}'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "sourcing_sprints_status_check" CHECK ("sourcing_sprints"."status" in ('active', 'paused', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "sprint_results" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sprint_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"profile" jsonb NOT NULL,
	"matched_variant" text NOT NULL,
	"score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sprint_results_sprint_source_unique" UNIQUE("sprint_id","source","source_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_sprints_organization_id_id_unique" ON "sourcing_sprints" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "sourcing_sprints" ADD CONSTRAINT "sourcing_sprints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_sprints" ADD CONSTRAINT "sourcing_sprints_creator_user_id_auth_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_results" ADD CONSTRAINT "sprint_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_results" ADD CONSTRAINT "sprint_results_sprint_id_sourcing_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sourcing_sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_results" ADD CONSTRAINT "sprint_results_organization_sprint_fk" FOREIGN KEY ("organization_id","sprint_id") REFERENCES "public"."sourcing_sprints"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sourcing_sprints_org_status_last_run_idx" ON "sourcing_sprints" USING btree ("organization_id","status","last_run_at");--> statement-breakpoint
CREATE INDEX "sprint_results_sprint_created_idx" ON "sprint_results" USING btree ("sprint_id","created_at");