CREATE TABLE "interview_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"evidence_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"edited_by_user_id" text,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_briefs_status_check" CHECK ("interview_briefs"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "interview_briefs_version_check" CHECK ("interview_briefs"."version" > 0),
	CONSTRAINT "interview_briefs_provenance_check" CHECK (("interview_briefs"."provider" is null and "interview_briefs"."model" is null and "interview_briefs"."prompt_version" is null)
          or ("interview_briefs"."provider" is not null and "interview_briefs"."model" is not null and "interview_briefs"."prompt_version" is not null))
);
--> statement-breakpoint
ALTER TABLE "interview_briefs" ADD CONSTRAINT "interview_briefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_briefs" ADD CONSTRAINT "interview_briefs_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_briefs" ADD CONSTRAINT "interview_briefs_edited_by_user_id_auth_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_briefs" ADD CONSTRAINT "interview_briefs_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_briefs_organization_id_id_unique" ON "interview_briefs" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_briefs_event_version_unique" ON "interview_briefs" USING btree ("organization_id","event_id","version");--> statement-breakpoint
CREATE INDEX "interview_briefs_event_idx" ON "interview_briefs" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "interview_briefs_retention_idx" ON "interview_briefs" USING btree ("retention_expires_at");