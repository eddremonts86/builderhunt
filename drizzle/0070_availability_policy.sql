CREATE TABLE "availability_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"default_reminder_offsets" integer[] DEFAULT '{}' NOT NULL,
	"default_reminder_channels" text[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_policies_version_check" CHECK ("availability_policies"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "availability_policies" ADD CONSTRAINT "availability_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_policies" ADD CONSTRAINT "availability_policies_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "availability_policies_organization_id_id_unique" ON "availability_policies" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_policies_owner_unique" ON "availability_policies" USING btree ("organization_id","owner_user_id");