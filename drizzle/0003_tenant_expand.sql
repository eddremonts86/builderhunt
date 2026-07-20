ALTER TABLE "alert_triggers" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "builder_notes" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "organization_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_triggers_organization_id_id_unique" ON "alert_triggers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_organization_id_id_unique" ON "alerts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_notes_organization_id_id_unique" ON "builder_notes" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "builders_organization_id_id_unique" ON "builders" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_progress_organization_id_id_unique" ON "onboarding_progress" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_queries_organization_id_id_unique" ON "saved_queries" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "alert_triggers" ADD CONSTRAINT "alert_triggers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_triggers" ADD CONSTRAINT "alert_triggers_organization_alert_fk" FOREIGN KEY ("organization_id","alert_id") REFERENCES "public"."alerts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_triggers" ADD CONSTRAINT "alert_triggers_organization_builder_fk" FOREIGN KEY ("organization_id","builder_id") REFERENCES "public"."builders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_query_fk" FOREIGN KEY ("organization_id","query_id") REFERENCES "public"."saved_queries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_notes" ADD CONSTRAINT "builder_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builder_notes" ADD CONSTRAINT "builder_notes_organization_builder_fk" FOREIGN KEY ("organization_id","builder_id") REFERENCES "public"."builders"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
