CREATE TABLE "access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invite_consumed_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" text,
	"note" text,
	CONSTRAINT "access_requests_email_unique" UNIQUE("email"),
	CONSTRAINT "access_requests_status_check" CHECK ("access_requests"."status" in ('pending', 'approved', 'revoked')),
	CONSTRAINT "access_requests_decided_at_check" CHECK (("access_requests"."status" = 'pending') = ("access_requests"."decided_at" is null)),
	CONSTRAINT "access_requests_invite_expiry_check" CHECK (("access_requests"."invite_token_hash" is null) = ("access_requests"."invite_expires_at" is null))
);
--> statement-breakpoint
CREATE INDEX "access_requests_status_requested_idx" ON "access_requests" USING btree ("status","requested_at");