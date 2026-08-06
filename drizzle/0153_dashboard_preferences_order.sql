-- Pinning, ordering, and the two version numbers (plans/ui-dashboard Wave 6).
--
-- **No companion grants migration, unlike `0152`.** `GRANT SELECT, INSERT, UPDATE ON
-- dashboard_preferences` is a table-level privilege, so it covers columns added later; the RLS
-- policies key on `organization_id`, which has not changed. A grants file here would re-run four
-- statements that are already true. The convention `0152` documents is that RLS and grants never live
-- in a *generated* file — not that every generated file needs one.
--
-- `revision` defaults to 0 rather than 1, so an existing row and a row that has never been written
-- both start where a first-time client claims to be. The first save moves it to 1.
ALTER TABLE "dashboard_preferences" ADD COLUMN "pinned_widget_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD COLUMN "ordered_widget_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD CONSTRAINT "dashboard_preferences_pinned_is_array_check" CHECK (jsonb_typeof("dashboard_preferences"."pinned_widget_ids") = 'array');--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD CONSTRAINT "dashboard_preferences_ordered_is_array_check" CHECK (jsonb_typeof("dashboard_preferences"."ordered_widget_ids") = 'array');--> statement-breakpoint
ALTER TABLE "dashboard_preferences" ADD CONSTRAINT "dashboard_preferences_list_bounds_check" CHECK (
      jsonb_array_length("dashboard_preferences"."hidden_widget_ids") <= 40
      and jsonb_array_length("dashboard_preferences"."pinned_widget_ids") <= 40
      and jsonb_array_length("dashboard_preferences"."ordered_widget_ids") <= 40
    );