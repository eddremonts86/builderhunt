CREATE TABLE "billing_risk_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"event_type" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_risk_events_type_check" CHECK ("billing_risk_events"."event_type" in ('payment_failure', 'card_rotation', 'dispute_opened'))
);
--> statement-breakpoint
CREATE TABLE "billing_risk_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_risk_events" ADD CONSTRAINT "billing_risk_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_risk_exceptions" ADD CONSTRAINT "billing_risk_exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_risk_exceptions" ADD CONSTRAINT "billing_risk_exceptions_issued_by_user_id_auth_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_risk_events_organization_id_id_unique" ON "billing_risk_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "billing_risk_events_org_type_created_idx" ON "billing_risk_events" USING btree ("organization_id","event_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_risk_exceptions_organization_id_id_unique" ON "billing_risk_exceptions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "billing_risk_exceptions_org_expires_idx" ON "billing_risk_exceptions" USING btree ("organization_id","expires_at");