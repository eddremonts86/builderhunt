CREATE TABLE "privacy_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invitation_id" uuid NOT NULL,
	"session_id" uuid,
	"subject_email_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"notice_version" text NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"request_evidence_hash" text NOT NULL,
	"supersedes_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_consents_purpose_check" CHECK ("privacy_consents"."purpose" in ('terms_and_privacy', 'candidate_document_processing', 'public_web_import', 'ai_interview_assistance', 'live_audio_transcription')),
	CONSTRAINT "privacy_consents_decision_check" CHECK ("privacy_consents"."decision" in ('accepted', 'declined')),
	CONSTRAINT "privacy_consents_withdrawal_check" CHECK ("privacy_consents"."withdrawn_at" is null or "privacy_consents"."decision" = 'accepted'),
	CONSTRAINT "privacy_consents_supersedes_self_check" CHECK ("privacy_consents"."supersedes_id" is null or "privacy_consents"."supersedes_id" != "privacy_consents"."id")
);
--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_organization_invitation_fk" FOREIGN KEY ("organization_id","invitation_id") REFERENCES "public"."scheduling_invitations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_consents_organization_id_id_unique" ON "privacy_consents" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_consents_subject_purpose_notice_decision_unique" ON "privacy_consents" USING btree ("organization_id","invitation_id","subject_email_hash","purpose","notice_version","decision");--> statement-breakpoint
CREATE INDEX "privacy_consents_invitation_purpose_idx" ON "privacy_consents" USING btree ("organization_id","invitation_id","purpose");--> statement-breakpoint
CREATE INDEX "privacy_consents_subject_idx" ON "privacy_consents" USING btree ("organization_id","subject_email_hash");--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_organization_supersedes_fk" FOREIGN KEY ("organization_id","supersedes_id") REFERENCES "public"."privacy_consents"("organization_id","id") ON DELETE set null ON UPDATE no action;
