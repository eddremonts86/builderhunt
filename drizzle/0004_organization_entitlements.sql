CREATE TABLE "organization_entitlements" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"billing_period" text DEFAULT 'none' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"seat_limit" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_entitlements_tier_check" CHECK ("organization_entitlements"."tier" in ('free', 'pro', 'team')),
	CONSTRAINT "organization_entitlements_status_check" CHECK ("organization_entitlements"."status" in ('active', 'past_due', 'canceled', 'trialing')),
	CONSTRAINT "organization_entitlements_period_check" CHECK ("organization_entitlements"."billing_period" in ('none', 'monthly', 'annual')),
	CONSTRAINT "organization_entitlements_seat_limit_check" CHECK ("organization_entitlements"."seat_limit" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "organization_plan_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"from_tier" text,
	"to_tier" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_plan_changes_from_tier_check" CHECK ("organization_plan_changes"."from_tier" is null or "organization_plan_changes"."from_tier" in ('free', 'pro', 'team')),
	CONSTRAINT "organization_plan_changes_to_tier_check" CHECK ("organization_plan_changes"."to_tier" in ('free', 'pro', 'team'))
);
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_plan_changes" ADD CONSTRAINT "organization_plan_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_plan_changes" ADD CONSTRAINT "organization_plan_changes_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_plan_changes_org_created_idx" ON "organization_plan_changes" USING btree ("organization_id","created_at");