CREATE TABLE "self_managed_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"duration_seconds" integer,
	"checksum_sha256" text NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "self_managed_attachments_kind_check" CHECK ("self_managed_attachments"."kind" in ('cv', 'work-sample', 'certificate', 'other')),
	CONSTRAINT "self_managed_attachments_size_check" CHECK ("self_managed_attachments"."size_bytes" > 0 and "self_managed_attachments"."size_bytes" <= 26214400),
	CONSTRAINT "self_managed_attachments_checksum_check" CHECK ("self_managed_attachments"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "self_managed_handle_reservations" (
	"handle" text PRIMARY KEY NOT NULL,
	"reserved_by_user_id" text NOT NULL,
	"reserved_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "self_managed_handle_reservations_handle_check" CHECK ("self_managed_handle_reservations"."handle" ~ '^[a-z0-9-]{3,32}$')
);
--> statement-breakpoint
CREATE TABLE "self_managed_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"headline" text,
	"bio" text,
	"location_city" text,
	"location_country_code" text,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'draft' NOT NULL,
	"promoted_to_builder_claim_id" text,
	"declared_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "self_managed_profiles_visibility_check" CHECK ("self_managed_profiles"."visibility" in ('public', 'unlisted', 'draft')),
	CONSTRAINT "self_managed_profiles_handle_check" CHECK ("self_managed_profiles"."handle" ~ '^[a-z0-9-]{3,32}$'),
	CONSTRAINT "self_managed_profiles_country_check" CHECK ("self_managed_profiles"."location_country_code" is null or "self_managed_profiles"."location_country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD CONSTRAINT "self_managed_attachments_profile_id_self_managed_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."self_managed_profiles"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "self_managed_handle_reservations" ADD CONSTRAINT "self_managed_handle_reservations_reserved_by_user_id_auth_users_id_fk" FOREIGN KEY ("reserved_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "self_managed_profiles" ADD CONSTRAINT "self_managed_profiles_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "self_managed_profiles" ADD CONSTRAINT "self_managed_profiles_promoted_to_builder_claim_id_builder_claims_id_fk" FOREIGN KEY ("promoted_to_builder_claim_id") REFERENCES "public"."builder_claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "self_managed_attachments_storage_key_unique" ON "self_managed_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "self_managed_attachments_profile_idx" ON "self_managed_attachments" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "self_managed_handle_reservations_expires_idx" ON "self_managed_handle_reservations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "self_managed_profiles_handle_live_unique" ON "self_managed_profiles" USING btree ("handle") WHERE "self_managed_profiles"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "self_managed_profiles_owner_live_unique" ON "self_managed_profiles" USING btree ("owner_user_id") WHERE "self_managed_profiles"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "self_managed_profiles_visibility_idx" ON "self_managed_profiles" USING btree ("visibility");--> statement-breakpoint

-- Row-level security (plan: phase-2/07-perfiles-autogestionados).
--
-- `0171_user_preferences` is the account-subject precedent and its policies are owner-only, keyed on
-- `app.user_id`. Copying that shape here would be wrong in a way that looks right: these profiles are
-- read by strangers at `/u/<handle>`, so an owner-only policy makes every public profile invisible and
-- the failure reads as "no profiles exist" rather than as a policy.
--
-- So each table pairs an owner policy with a public-read policy. The public one is scoped to live rows
-- the owner chose to expose: `draft` is never readable by anybody else, and `deleted_at` ends public
-- access immediately rather than waiting for the thirty-day handle release.
--
-- `unlisted` IS publicly readable here on purpose. It is reachable by anyone holding the link, which is
-- what unlisted means; keeping it out of *search* is the route's job, not the row's, because a policy
-- cannot tell a direct visit from a listing.
ALTER TABLE "self_managed_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "self_managed_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "self_managed_attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "self_managed_handle_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "self_managed_handle_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "self_managed_profiles_owner_all" ON "self_managed_profiles"
	FOR ALL TO "builderhunt_app"
	USING ("owner_user_id" = NULLIF(current_setting('app.user_id', true), ''))
	WITH CHECK ("owner_user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint

CREATE POLICY "self_managed_profiles_public_select" ON "self_managed_profiles"
	FOR SELECT TO "builderhunt_app"
	USING ("visibility" in ('public', 'unlisted') AND "deleted_at" IS NULL);--> statement-breakpoint

CREATE POLICY "self_managed_attachments_owner_all" ON "self_managed_attachments"
	FOR ALL TO "builderhunt_app"
	USING (EXISTS (
		SELECT 1 FROM "self_managed_profiles" p
		WHERE p."id" = "self_managed_attachments"."profile_id"
		  AND p."owner_user_id" = NULLIF(current_setting('app.user_id', true), '')
	))
	WITH CHECK (EXISTS (
		SELECT 1 FROM "self_managed_profiles" p
		WHERE p."id" = "self_managed_attachments"."profile_id"
		  AND p."owner_user_id" = NULLIF(current_setting('app.user_id', true), '')
	));--> statement-breakpoint

-- An attachment inherits its profile's exposure. Written as a subquery rather than a denormalised
-- `visibility` column so a profile going back to `draft` hides its attachments in the same statement —
-- two columns to keep in step is how an attachment outlives the decision to hide it.
CREATE POLICY "self_managed_attachments_public_select" ON "self_managed_attachments"
	FOR SELECT TO "builderhunt_app"
	USING ("deleted_at" IS NULL AND EXISTS (
		SELECT 1 FROM "self_managed_profiles" p
		WHERE p."id" = "self_managed_attachments"."profile_id"
		  AND p."visibility" in ('public', 'unlisted')
		  AND p."deleted_at" IS NULL
	));--> statement-breakpoint

-- Reservations are never public: the whole point is that a handle is held, and publishing who holds
-- what is a list of names worth squatting against.
CREATE POLICY "self_managed_handle_reservations_owner_all" ON "self_managed_handle_reservations"
	FOR ALL TO "builderhunt_app"
	USING ("reserved_by_user_id" = NULLIF(current_setting('app.user_id', true), ''))
	WITH CHECK ("reserved_by_user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "self_managed_profiles" TO "builderhunt_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "self_managed_attachments" TO "builderhunt_app";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "self_managed_handle_reservations" TO "builderhunt_app";--> statement-breakpoint

-- The worker sweeps expired reservations and enforces retention on soft-deleted rows. It bypasses RLS
-- through its own role rather than through a policy, so nothing here widens what the app can see.
GRANT SELECT, DELETE ON "self_managed_handle_reservations" TO "builderhunt_worker";--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON "self_managed_profiles" TO "builderhunt_worker";--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON "self_managed_attachments" TO "builderhunt_worker";
