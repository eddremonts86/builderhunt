CREATE TABLE "conversion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"surface" text NOT NULL,
	"session_id" text NOT NULL,
	"variant" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"server_day" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_events_name_check" CHECK ("conversion_events"."name" in (
        'landing_view', 'hero_signup_click', 'hero_explore_click',
        'explore_search_complete', 'explore_signup_click', 'signup_submit', 'signup_complete'
      )),
	CONSTRAINT "conversion_events_surface_check" CHECK ("conversion_events"."surface" in ('hero', 'final_cta', 'explore', 'signup')),
	CONSTRAINT "conversion_events_variant_check" CHECK ("conversion_events"."variant" in ('baseline', 'treatment'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_events_identity_unique" ON "conversion_events" USING btree ("session_id","name","surface","variant");--> statement-breakpoint
CREATE INDEX "conversion_events_server_day_idx" ON "conversion_events" USING btree ("server_day");--> statement-breakpoint
CREATE INDEX "conversion_events_name_server_day_idx" ON "conversion_events" USING btree ("name","server_day");--> statement-breakpoint
CREATE INDEX "conversion_events_created_at_idx" ON "conversion_events" USING btree ("created_at");