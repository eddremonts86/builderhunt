-- Pricing & Plans (Plan 14): admin-managed, no Stripe
CREATE TABLE IF NOT EXISTS "plans" (
	"user_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan_ends_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_plan" text,
	"to_plan" text NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"requested_plan" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
