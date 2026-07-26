CREATE TABLE "profile_removal_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"normalized_profile_url" text NOT NULL,
	"requester_email_hash" text,
	"challenge_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_removal_requests_status_check" CHECK ("profile_removal_requests"."status" in ('pending', 'verified', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "profile_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"normalized_profile_url_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "profile_suppressions_reason_check" CHECK ("profile_suppressions"."reason" in ('verified-removal', 'legal', 'abuse'))
);
--> statement-breakpoint
CREATE INDEX "profile_removal_requests_status_expires_idx" ON "profile_removal_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "profile_removal_requests_source_source_id_idx" ON "profile_removal_requests" USING btree ("source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_suppressions_active_source_source_id_unique" ON "profile_suppressions" USING btree ("source","source_id") WHERE "profile_suppressions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "profile_suppressions_source_source_id_idx" ON "profile_suppressions" USING btree ("source","source_id");