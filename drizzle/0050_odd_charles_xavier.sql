CREATE TABLE "devpost_ingestion_state" (
	"id" text PRIMARY KEY NOT NULL,
	"keyword_index" integer DEFAULT 0 NOT NULL,
	"page" integer DEFAULT 1 NOT NULL,
	"last_run_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{"runs":0,"projectsSeen":0,"profilesUpserted":0,"errors":0}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devpost_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"profile_url" text NOT NULL,
	"projects_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
