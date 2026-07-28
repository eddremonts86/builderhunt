CREATE TABLE "calendar_event_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"recurrence_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_event_exceptions" ADD CONSTRAINT "calendar_event_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_exceptions" ADD CONSTRAINT "calendar_event_exceptions_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_exceptions_organization_id_id_unique" ON "calendar_event_exceptions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_exceptions_identity_unique" ON "calendar_event_exceptions" USING btree ("organization_id","event_id","recurrence_id");