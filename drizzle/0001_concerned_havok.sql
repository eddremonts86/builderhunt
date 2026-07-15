CREATE TABLE "builder_claim_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"builder_id" text NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_claim_requests_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "builder_profile_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"builder_id" text NOT NULL,
	"viewer_id" text,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "is_claimed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "claimed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "is_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "open_to_status" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "claimed_topics" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "builder_claim_requests" ADD CONSTRAINT "builder_claim_requests_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_profile_views" ADD CONSTRAINT "builder_profile_views_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_profile_views" ADD CONSTRAINT "builder_profile_views_viewer_id_auth_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builder_views_builder_idx" ON "builder_profile_views" USING btree ("builder_id");--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_claimed_by_user_id_auth_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;