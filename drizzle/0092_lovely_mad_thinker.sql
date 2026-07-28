-- Live interview persistence: sessions, transcript segments, suggestions and reports (plan:
-- calendar-scheduling-interview-intelligence, Phase 9).
--
-- **Hand-reordered.** drizzle-kit emits every ADD CONSTRAINT before every CREATE UNIQUE INDEX, and the
-- composite foreign keys here reference `interview_sessions(organization_id, id)` — an index this file
-- also creates. Applied in the generated order, Postgres rejects the first of them with 42830, "there
-- is no unique constraint matching given keys for referenced table". So the unique indexes come first.
-- The same reorder was needed in 0084 for the same reason; regenerating this file will undo it.
--
-- No audio column anywhere in these four tables, and no storage key or object reference either.
-- Transcription is streamed and only text is kept: the consent a candidate gives is for transient live
-- transcription, not for a recording, and a column that could hold or point at audio would make that
-- consent inaccurate the moment somebody used it. `scripts/db/audit-schema.ts` asserts this.

CREATE TABLE "interview_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"evidence_segment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"edited_by_user_id" text,
	"finalized_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_reports_status_check" CHECK ("interview_reports"."status" in ('draft', 'final')),
	CONSTRAINT "interview_reports_version_check" CHECK ("interview_reports"."version" > 0),
	CONSTRAINT "interview_reports_provenance_check" CHECK (("interview_reports"."provider" is null and "interview_reports"."model" is null and "interview_reports"."prompt_version" is null)
          or ("interview_reports"."provider" is not null and "interview_reports"."model" is not null and "interview_reports"."prompt_version" is not null)),
	CONSTRAINT "interview_reports_finalized_check" CHECK (("interview_reports"."status" = 'final') = ("interview_reports"."finalized_at" is not null))
);--> statement-breakpoint
CREATE TABLE "interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"state" text DEFAULT 'not_started' NOT NULL,
	"capture_mode" text NOT NULL,
	"language" text NOT NULL,
	"provider" text NOT NULL,
	"consent_notice_version" text NOT NULL,
	"browser_name" text,
	"browser_major" text,
	"capture_capability" text NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"provider_request_id" text,
	"provider_billed_seconds" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_sessions_state_check" CHECK ("interview_sessions"."state" in ('not_started', 'consent_pending', 'ready', 'live', 'processing', 'review', 'finalized', 'paused', 'failed', 'abandoned')),
	CONSTRAINT "interview_sessions_capture_mode_check" CHECK ("interview_sessions"."capture_mode" in ('in_person', 'remote_call')),
	CONSTRAINT "interview_sessions_language_check" CHECK ("interview_sessions"."language" in ('en', 'da')),
	CONSTRAINT "interview_sessions_capability_check" CHECK ("interview_sessions"."capture_capability" in ('microphone_and_shared_audio_available', 'microphone_only', 'audio_capture_unsupported')),
	CONSTRAINT "interview_sessions_billed_seconds_check" CHECK ("interview_sessions"."provider_billed_seconds" >= 0),
	CONSTRAINT "interview_sessions_version_check" CHECK ("interview_sessions"."version" > 0),
	CONSTRAINT "interview_sessions_finished_check" CHECK (("interview_sessions"."state" in ('finalized', 'failed', 'abandoned')) = ("interview_sessions"."finished_at" is not null))
);--> statement-breakpoint
CREATE TABLE "interview_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"question" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence_segment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"prompt_version" text NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_suggestions_state_check" CHECK ("interview_suggestions"."state" in ('proposed', 'used', 'saved', 'dismissed')),
	CONSTRAINT "interview_suggestions_sequence_check" CHECK ("interview_suggestions"."sequence" >= 0)
);--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"provider_segment_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"speaker_estimate" text NOT NULL,
	"speaker_mapping" text,
	"text" text NOT NULL,
	"starts_ms" integer NOT NULL,
	"ends_ms" integer NOT NULL,
	"confidence" numeric(4, 3),
	"corrected_by_user_id" text,
	"corrected_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_segments_speaker_estimate_check" CHECK ("transcript_segments"."speaker_estimate" in ('speaker_a', 'speaker_b', 'unknown')),
	CONSTRAINT "transcript_segments_speaker_mapping_check" CHECK ("transcript_segments"."speaker_mapping" is null or "transcript_segments"."speaker_mapping" in ('organizer', 'candidate_or_remote')),
	CONSTRAINT "transcript_segments_sequence_check" CHECK ("transcript_segments"."sequence" >= 0),
	CONSTRAINT "transcript_segments_timing_check" CHECK ("transcript_segments"."starts_ms" >= 0 and "transcript_segments"."ends_ms" > "transcript_segments"."starts_ms"),
	CONSTRAINT "transcript_segments_confidence_check" CHECK ("transcript_segments"."confidence" is null or ("transcript_segments"."confidence" >= 0 and "transcript_segments"."confidence" <= 1)),
	CONSTRAINT "transcript_segments_correction_check" CHECK (("transcript_segments"."corrected_by_user_id" is null) = ("transcript_segments"."corrected_at" is null))
);--> statement-breakpoint
CREATE UNIQUE INDEX "interview_reports_organization_id_id_unique" ON "interview_reports" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_reports_event_version_unique" ON "interview_reports" USING btree ("organization_id","event_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_sessions_organization_id_id_unique" ON "interview_sessions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_sessions_event_unique" ON "interview_sessions" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_suggestions_organization_id_id_unique" ON "interview_suggestions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_suggestions_sequence_unique" ON "interview_suggestions" USING btree ("organization_id","session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_organization_id_id_unique" ON "transcript_segments" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_provider_unique" ON "transcript_segments" USING btree ("organization_id","session_id","provider_segment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_sequence_unique" ON "transcript_segments" USING btree ("organization_id","session_id","sequence");--> statement-breakpoint
ALTER TABLE "interview_reports" ADD CONSTRAINT "interview_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_reports" ADD CONSTRAINT "interview_reports_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_reports" ADD CONSTRAINT "interview_reports_edited_by_user_id_auth_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_reports" ADD CONSTRAINT "interview_reports_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_suggestions" ADD CONSTRAINT "interview_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_suggestions" ADD CONSTRAINT "interview_suggestions_organization_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "public"."interview_sessions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_corrected_by_user_id_auth_users_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_organization_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "public"."interview_sessions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interview_reports_event_idx" ON "interview_reports" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "interview_reports_retention_idx" ON "interview_reports" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "interview_sessions_state_idx" ON "interview_sessions" USING btree ("organization_id","state");--> statement-breakpoint
CREATE INDEX "interview_sessions_heartbeat_idx" ON "interview_sessions" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "interview_sessions_retention_idx" ON "interview_sessions" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "interview_suggestions_session_idx" ON "interview_suggestions" USING btree ("organization_id","session_id");--> statement-breakpoint
CREATE INDEX "interview_suggestions_retention_idx" ON "interview_suggestions" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "transcript_segments_session_idx" ON "transcript_segments" USING btree ("organization_id","session_id","sequence");--> statement-breakpoint
CREATE INDEX "transcript_segments_retention_idx" ON "transcript_segments" USING btree ("retention_expires_at");
