CREATE TABLE "dashboard_preferences" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"density" text DEFAULT 'bento' NOT NULL,
	"hidden_widget_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_preferences_pkey" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "dashboard_preferences_density_check" CHECK ("dashboard_preferences"."density" in ('bento', 'sections')),
	CONSTRAINT "dashboard_preferences_hidden_is_array_check" CHECK (jsonb_typeof("dashboard_preferences"."hidden_widget_ids") = 'array')
);
--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD CONSTRAINT "dashboard_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD CONSTRAINT "dashboard_preferences_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;