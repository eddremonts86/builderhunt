-- User preferences, account-subject (plan phase-2/02-segmentacion-usuarios).
--
-- ## Hand-edited, and why
--
-- `pnpm db:generate` produced this file with four `CREATE TABLE`s: `user_preferences` plus
-- `platform_admin_preferences`, `platform_beta_mode` and `service_metric_buckets`. Those three
-- already exist — `0167`, `0169` and `0170` created them — so applying that file would have failed
-- on the first one and taken every statement after it down with it.
--
-- The cause is a stale snapshot chain rather than anything about this change: those three were
-- **custom** migrations, whose SQL drizzle-kit does not read, so `0170_snapshot.json` describes 124
-- tables while the database has 127. Generating from that snapshot diffs against a world where the
-- three were never created. `0171_snapshot.json` is correct (128 tables), so the chain repairs
-- itself here and the next generated migration will diff from reality — but the same trap is waiting
-- for whoever writes the next custom migration and then generates.
--
-- Only the `user_preferences` statements are kept below. Nothing else in this file was invented; the
-- table and constraint are exactly as generated.
--
-- ## Why the segment columns are nullable
--
-- Every existing account has no segment and may keep it. `null` means "never asked", which the
-- application maps to the `general` preset. A `NOT NULL DEFAULT 'other'` would have been the easy
-- shape and would have erased the difference between "told us they are something else" and "we
-- never asked" — two states the analytics in this plan have to tell apart.
--
-- ## Row-level security
--
-- Keyed on `app.user_id` alone, because this table is account-subject: a person keeps their goal
-- when they switch organisation, so there is no `organization_id` here for a tenant filter to use.
-- This is the same shape as `builder_claims` and `user_devices`, and deliberately *not*
-- `dashboard_preferences`, which is tenant-private and filters on `app.organization_id`.
--
-- FORCE, matching those siblings: without it the table owner bypasses the policies, and migrations
-- and admin sessions connect as the owner.
--
-- No DELETE policy and no DELETE grant. Removing a person's preferences is not something the
-- application does — the row dies with the account through `ON DELETE CASCADE` from `auth_users`,
-- which is what the spec means by account deletion removing preferences. A grant nobody needs is a
-- grant that can be misused.
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"primary_segment" text,
	"segment_source" text,
	"segment_schema_version" integer,
	"segment_selected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_preferences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_preferences_app_select" ON "user_preferences"
	FOR SELECT TO "builderhunt_app"
	USING ("user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "user_preferences_app_insert" ON "user_preferences"
	FOR INSERT TO "builderhunt_app"
	WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "user_preferences_app_update" ON "user_preferences"
	FOR UPDATE TO "builderhunt_app"
	USING ("user_id" = NULLIF(current_setting('app.user_id', true), ''))
	WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "user_preferences" TO "builderhunt_app";
