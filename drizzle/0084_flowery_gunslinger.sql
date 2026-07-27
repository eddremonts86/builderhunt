-- Reordered by hand after generation: drizzle-kit emits every ADD CONSTRAINT before every
-- CREATE UNIQUE INDEX, so `document_extractions_organization_document_fk` referenced
-- candidate_documents(organization_id, id) while the unique index backing that pair did not yet
-- exist, and Postgres rejected the whole migration with 42830. The three candidate-key indexes
-- are moved ahead of the constraint block; nothing else changed.
CREATE TABLE "candidate_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"declared_media_type" text NOT NULL,
	"detected_media_type" text,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"rejection_code" text,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_documents_scan_status_check" CHECK ("candidate_documents"."scan_status" in ('pending', 'scanning', 'clean', 'infected', 'failed')),
	CONSTRAINT "candidate_documents_extraction_status_check" CHECK ("candidate_documents"."extraction_status" in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "candidate_documents_bytes_check" CHECK ("candidate_documents"."bytes" > 0),
	CONSTRAINT "candidate_documents_sha256_check" CHECK ("candidate_documents"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "candidate_documents_no_audio_check" CHECK ("candidate_documents"."declared_media_type" not like 'audio/%' and ("candidate_documents"."detected_media_type" is null or "candidate_documents"."detected_media_type" not like 'audio/%')),
	CONSTRAINT "candidate_documents_rejection_check" CHECK (("candidate_documents"."scan_status" in ('infected', 'failed')) = ("candidate_documents"."rejection_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "candidate_web_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"candidate_link_id" uuid NOT NULL,
	"final_url" text NOT NULL,
	"source_policy_version" text NOT NULL,
	"robots_result" text NOT NULL,
	"fetched_at" timestamp with time zone,
	"http_etag" text,
	"http_last_modified" text,
	"response_sha256" text,
	"content_sha256" text,
	"media_type" text,
	"bytes" integer,
	"extraction_version" text,
	"extracted_text" text,
	"evidence_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_web_imports_status_check" CHECK ("candidate_web_imports"."status" in ('pending', 'running', 'succeeded', 'failed', 'blocked')),
	CONSTRAINT "candidate_web_imports_robots_result_check" CHECK ("candidate_web_imports"."robots_result" in ('allowed', 'disallowed', 'unavailable')),
	CONSTRAINT "candidate_web_imports_outcome_check" CHECK (("candidate_web_imports"."status" in ('failed', 'blocked')) = ("candidate_web_imports"."error_code" is not null)),
	CONSTRAINT "candidate_web_imports_bytes_check" CHECK ("candidate_web_imports"."bytes" is null or "candidate_web_imports"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"parser" text NOT NULL,
	"parser_version" text NOT NULL,
	"content_sha256" text NOT NULL,
	"plain_text" text,
	"evidence_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_extractions_status_check" CHECK ("document_extractions"."status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "document_extractions_content_sha256_check" CHECK ("document_extractions"."content_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "document_extractions_outcome_check" CHECK (("document_extractions"."status" = 'failed') = ("document_extractions"."error_code" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_documents_organization_id_id_unique" ON "candidate_documents" USING btree ("organization_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_web_imports_organization_id_id_unique" ON "candidate_web_imports" USING btree ("organization_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_extractions_organization_id_id_unique" ON "document_extractions" USING btree ("organization_id","id");
--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_organization_submission_fk" FOREIGN KEY ("organization_id","submission_id") REFERENCES "public"."candidate_submissions"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_web_imports" ADD CONSTRAINT "candidate_web_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_web_imports" ADD CONSTRAINT "candidate_web_imports_organization_link_fk" FOREIGN KEY ("organization_id","candidate_link_id") REFERENCES "public"."candidate_links"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_organization_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."candidate_documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_documents_object_key_unique" ON "candidate_documents" USING btree ("object_key");
--> statement-breakpoint
CREATE INDEX "candidate_documents_submission_idx" ON "candidate_documents" USING btree ("organization_id","submission_id");
--> statement-breakpoint
CREATE INDEX "candidate_documents_scan_status_idx" ON "candidate_documents" USING btree ("scan_status");
--> statement-breakpoint
CREATE INDEX "candidate_documents_retention_idx" ON "candidate_documents" USING btree ("retention_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_web_imports_link_content_unique" ON "candidate_web_imports" USING btree ("organization_id","candidate_link_id","content_sha256");
--> statement-breakpoint
CREATE INDEX "candidate_web_imports_status_idx" ON "candidate_web_imports" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "candidate_web_imports_retention_idx" ON "candidate_web_imports" USING btree ("retention_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_extractions_document_parser_content_unique" ON "document_extractions" USING btree ("organization_id","document_id","parser_version","content_sha256");
--> statement-breakpoint
CREATE INDEX "document_extractions_status_idx" ON "document_extractions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "document_extractions_retention_idx" ON "document_extractions" USING btree ("retention_expires_at");
