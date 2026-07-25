CREATE TABLE "work_sample_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"builder_identity_id" text,
	"sample_url" text NOT NULL,
	"sample_type" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_sample_user_url_unique" UNIQUE("user_id","sample_url"),
	CONSTRAINT "work_sample_analyses_sample_type_check" CHECK ("work_sample_analyses"."sample_type" in ('repo', 'pr', 'file'))
);
--> statement-breakpoint
ALTER TABLE "work_sample_analyses" ADD CONSTRAINT "work_sample_analyses_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sample_analyses" ADD CONSTRAINT "work_sample_analyses_builder_identity_id_builder_identities_id_fk" FOREIGN KEY ("builder_identity_id") REFERENCES "public"."builder_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_sample_analyses_user_id_idx" ON "work_sample_analyses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "work_sample_analyses_builder_identity_id_idx" ON "work_sample_analyses" USING btree ("builder_identity_id");