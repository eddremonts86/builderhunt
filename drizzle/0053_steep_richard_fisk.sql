CREATE TABLE "public_radars" (
	"saved_query_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_radars_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "public_radars" ADD CONSTRAINT "public_radars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_radars" ADD CONSTRAINT "public_radars_organization_query_fk" FOREIGN KEY ("organization_id","saved_query_id") REFERENCES "public"."saved_queries"("organization_id","id") ON DELETE cascade ON UPDATE no action;