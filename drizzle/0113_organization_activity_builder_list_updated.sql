-- Wave 2 (plans/UI/tasks.md) "Shortlist metadata and visibility editing" adds a
-- builder_list_updated activity event; the type-known CHECK constraint (added in
-- 0107_organization_activity.sql) enumerates every allowed value explicitly, so a new
-- event type needs its own migration here, not just an application-layer registration.
ALTER TABLE "organization_activity" DROP CONSTRAINT "organization_activity_type_known";--> statement-breakpoint
ALTER TABLE "organization_activity" ADD CONSTRAINT "organization_activity_type_known" CHECK ("organization_activity"."type" in (
      'saved_query_created','saved_query_visibility_changed','saved_query_deleted',
      'builder_list_created','builder_list_item_added','builder_list_item_removed','builder_list_deleted',
      'builder_list_updated',
      'alert_created','feed_capability_minted','feed_capability_revoked'
    ));
