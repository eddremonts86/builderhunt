CREATE TABLE "builder_list_items" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"builder_identity_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builder_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_lists_visibility_check" CHECK ("builder_lists"."visibility" in ('private', 'organization'))
);
--> statement-breakpoint
ALTER TABLE "builder_list_items" ADD CONSTRAINT "builder_list_items_list_id_builder_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."builder_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_list_items" ADD CONSTRAINT "builder_list_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_list_items" ADD CONSTRAINT "builder_list_items_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_list_items" ADD CONSTRAINT "builder_list_items_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_list_items" ADD CONSTRAINT "builder_list_items_org_builder_tracked_fk" FOREIGN KEY ("organization_id","builder_identity_id") REFERENCES "public"."organization_builders"("organization_id","builder_identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_lists" ADD CONSTRAINT "builder_lists_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_lists" ADD CONSTRAINT "builder_lists_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_list_items_list_builder_unique" ON "builder_list_items" USING btree ("list_id","builder_identity_id");--> statement-breakpoint
CREATE INDEX "builder_list_items_org_builder_idx" ON "builder_list_items" USING btree ("organization_id","builder_identity_id");--> statement-breakpoint
CREATE INDEX "builder_lists_org_visibility_creator_idx" ON "builder_lists" USING btree ("organization_id","visibility","created_by_user_id");