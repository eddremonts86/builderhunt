CREATE TABLE "billing_notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"notification_type" text NOT NULL,
	"window_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_notification_log_type_check" CHECK ("billing_notification_log"."notification_type" in ('credit_expiry_30', 'credit_expiry_7', 'credit_expiry_1', 'subscription_renewal', 'grace_period', 'action_required', 'refund_decision', 'dispute_opened', 'reconciliation_mismatch'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notification_log_org_type_window_unique" ON "billing_notification_log" USING btree ("organization_id","notification_type","window_key");