CREATE TABLE "builder_processing_restrictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"builder_identity_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"actor_user_id" text,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "builder_processing_restrictions_reason_check" CHECK ("builder_processing_restrictions"."reason" in ('subject_request', 'legal', 'safety')),
	CONSTRAINT "builder_processing_restrictions_status_check" CHECK ("builder_processing_restrictions"."status" in ('active', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "enrichment_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"job_id" text NOT NULL,
	"builder_identity_id" text NOT NULL,
	"connector" text NOT NULL,
	"acquisition_mode" text NOT NULL,
	"source_url" text NOT NULL,
	"source_record_id" text,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence_bps" integer NOT NULL,
	"resolver_version" integer NOT NULL,
	"score_components" jsonb NOT NULL,
	"match_signals" jsonb NOT NULL,
	"contradictions" jsonb NOT NULL,
	"resolution" text DEFAULT 'review' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_evidence_confidence_check" CHECK ("enrichment_evidence"."confidence_bps" >= 0 and "enrichment_evidence"."confidence_bps" <= 10000),
	CONSTRAINT "enrichment_evidence_resolution_check" CHECK ("enrichment_evidence"."resolution" in ('accepted', 'review', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "enrichment_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"builder_identity_id" text NOT NULL,
	"requested_by_user_id" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_connectors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_jobs_status_check" CHECK ("enrichment_jobs"."status" in ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
	CONSTRAINT "enrichment_jobs_trigger_check" CHECK ("enrichment_jobs"."trigger" in ('manual', 'scheduled')),
	CONSTRAINT "enrichment_jobs_attempt_count_check" CHECK ("enrichment_jobs"."attempt_count" >= 0)
);
--> statement-breakpoint
-- Moved ahead of the ALTER TABLE block below: enrichment_evidence's composite
-- FK to (organization_id, id) requires this unique index to exist first, and
-- both tables are created in this same migration.
CREATE UNIQUE INDEX "enrichment_jobs_organization_id_id_unique" ON "enrichment_jobs" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "builder_processing_restrictions" ADD CONSTRAINT "builder_processing_restrictions_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_processing_restrictions" ADD CONSTRAINT "builder_processing_restrictions_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_evidence" ADD CONSTRAINT "enrichment_evidence_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_evidence" ADD CONSTRAINT "enrichment_evidence_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_evidence" ADD CONSTRAINT "enrichment_evidence_reviewed_by_user_id_auth_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_evidence" ADD CONSTRAINT "enrichment_evidence_organization_builder_fk" FOREIGN KEY ("organization_id","builder_identity_id") REFERENCES "public"."organization_builders"("organization_id","builder_identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_evidence" ADD CONSTRAINT "enrichment_evidence_organization_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."enrichment_jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_requested_by_user_id_auth_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_organization_builder_fk" FOREIGN KEY ("organization_id","builder_identity_id") REFERENCES "public"."organization_builders"("organization_id","builder_identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_processing_restrictions_active_unique" ON "builder_processing_restrictions" USING btree ("builder_identity_id") WHERE "builder_processing_restrictions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_evidence_organization_id_id_unique" ON "enrichment_evidence" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_evidence_org_builder_connector_hash_unique" ON "enrichment_evidence" USING btree ("organization_id","builder_identity_id","connector","content_hash");--> statement-breakpoint
CREATE INDEX "enrichment_evidence_org_builder_resolution_idx" ON "enrichment_evidence" USING btree ("organization_id","builder_identity_id","resolution","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_jobs_active_unique" ON "enrichment_jobs" USING btree ("organization_id","builder_identity_id") WHERE "enrichment_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "enrichment_jobs_worker_scan_idx" ON "enrichment_jobs" USING btree ("status","available_at","lease_expires_at");