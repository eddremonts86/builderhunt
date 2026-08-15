ALTER TABLE "conversion_events" DROP CONSTRAINT "conversion_events_name_check";--> statement-breakpoint
ALTER TABLE "conversion_events" DROP CONSTRAINT "conversion_events_surface_check";--> statement-breakpoint
DROP INDEX "conversion_events_identity_unique";--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "flow_version" integer;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "preset" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "step_key" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "segment_previous" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "segment_next" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "segment_source" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN "activation_type" text;--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_events_identity_unique" ON "conversion_events" USING btree ("session_id","name","surface","variant",coalesce("step_key", ''),coalesce("segment_next", ''));--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_flow_version_check" CHECK ("conversion_events"."flow_version" is null or "conversion_events"."flow_version" in (1, 2));--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_preset_check" CHECK ("conversion_events"."preset" is null or "conversion_events"."preset" in ('general', 'hiring', 'investing', 'building', 'other'));--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_name_check" CHECK ("conversion_events"."name" in (
        'landing_view', 'hero_signup_click', 'hero_explore_click',
        'explore_search_complete', 'explore_signup_click', 'signup_submit', 'signup_complete',
        'segment_prompt_viewed', 'segment_selected', 'segment_changed', 'segment_skipped',
        'activation_reached', 'onboarding_step_viewed', 'onboarding_step_completed',
        'onboarding_flow_exited'
      ));--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_surface_check" CHECK ("conversion_events"."surface" in ('hero', 'final_cta', 'explore', 'signup', 'onboarding', 'settings'));