CREATE TABLE "builder_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"builder_identity_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"evidence_source" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"verification_secret_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_claims_status_check" CHECK ("builder_claims"."status" in ('pending', 'verified', 'rejected', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "builder_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"profile_url" text NOT NULL,
	"followers_count" integer DEFAULT 0 NOT NULL,
	"language" text,
	"country" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"builder_identity_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_builders" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"builder_identity_id" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"status" text DEFAULT 'tracked' NOT NULL,
	"private_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_builders_visibility_check" CHECK ("organization_builders"."visibility" in ('private', 'organization')),
	CONSTRAINT "organization_builders_status_check" CHECK ("organization_builders"."status" in ('tracked', 'shortlisted', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "published_builder_profiles" (
	"builder_identity_id" text PRIMARY KEY NOT NULL,
	"published_by_user_id" text NOT NULL,
	"display_name" text,
	"bio" text,
	"open_to_status" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "builder_claims" ADD CONSTRAINT "builder_claims_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_claims" ADD CONSTRAINT "builder_claims_subject_user_id_auth_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_source_snapshots" ADD CONSTRAINT "builder_source_snapshots_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_builders" ADD CONSTRAINT "organization_builders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_builders" ADD CONSTRAINT "organization_builders_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_builders" ADD CONSTRAINT "organization_builders_creator_user_id_auth_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_builder_profiles" ADD CONSTRAINT "published_builder_profiles_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_builder_profiles" ADD CONSTRAINT "published_builder_profiles_published_by_user_id_auth_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_claims_active_identity_unique" ON "builder_claims" USING btree ("builder_identity_id") WHERE "builder_claims"."status" in ('pending', 'verified');--> statement-breakpoint
CREATE INDEX "builder_claims_subject_idx" ON "builder_claims" USING btree ("subject_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_identities_source_source_id_unique" ON "builder_identities" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "builder_identities_source_username_idx" ON "builder_identities" USING btree ("source","username");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_source_snapshots_identity_hash_unique" ON "builder_source_snapshots" USING btree ("builder_identity_id","content_hash");--> statement-breakpoint
CREATE INDEX "builder_source_snapshots_identity_observed_idx" ON "builder_source_snapshots" USING btree ("builder_identity_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_builders_org_identity_unique" ON "organization_builders" USING btree ("organization_id","builder_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_builders_organization_id_id_unique" ON "organization_builders" USING btree ("organization_id","id");