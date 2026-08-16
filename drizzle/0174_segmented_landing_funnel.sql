ALTER TABLE "conversion_events" DROP CONSTRAINT "conversion_events_name_check";--> statement-breakpoint
ALTER TABLE "conversion_events" DROP CONSTRAINT "conversion_events_surface_check";--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_name_check" CHECK ("conversion_events"."name" in (
        'landing_view', 'hero_signup_click', 'hero_explore_click',
        'explore_search_complete', 'explore_signup_click', 'signup_submit', 'signup_complete',
        'segment_prompt_viewed', 'segment_selected', 'segment_changed', 'segment_skipped',
        'activation_reached', 'onboarding_step_viewed', 'onboarding_step_completed',
        'onboarding_flow_exited',
        'segment_page_viewed', 'segment_selector_click', 'segment_page_cta_click'
      ));--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_surface_check" CHECK ("conversion_events"."surface" in ('hero', 'final_cta', 'explore', 'signup', 'onboarding', 'settings', 'segment_page'));