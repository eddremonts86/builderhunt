CREATE TABLE "organization_deletion_financial_records" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"organization_name" text NOT NULL,
	"deletion_type" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_customer_id" text,
	"last_subscription_tier" text,
	"last_subscription_interval" text,
	"subscription_canceled_at" timestamp with time zone,
	"retained_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_deletion_financial_records_deletion_type_check" CHECK ("organization_deletion_financial_records"."deletion_type" in ('scheduled', 'immediate'))
);
