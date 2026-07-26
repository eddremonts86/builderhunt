CREATE UNIQUE INDEX "calendar_events_organization_id_owner_unique" ON "calendar_events" USING btree ("organization_id","id","owner_user_id");--> statement-breakpoint
ALTER TABLE "event_participants" DROP CONSTRAINT "event_participants_organization_event_fk";
--> statement-breakpoint
ALTER TABLE "event_participants" ADD COLUMN "event_owner_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_organization_event_fk" FOREIGN KEY ("organization_id","event_id","event_owner_user_id") REFERENCES "public"."calendar_events"("organization_id","id","owner_user_id") ON DELETE cascade ON UPDATE no action;
