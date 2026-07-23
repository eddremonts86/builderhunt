CREATE TABLE "billing_contacts" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verification_secret_hash" text,
	"verification_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"set_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_contacts_status_check" CHECK ("billing_contacts"."status" in ('pending', 'verified'))
);
--> statement-breakpoint
ALTER TABLE "billing_contacts" ADD CONSTRAINT "billing_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_contacts" ADD CONSTRAINT "billing_contacts_set_by_user_id_auth_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;