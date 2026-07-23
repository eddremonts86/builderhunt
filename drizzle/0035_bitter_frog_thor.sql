CREATE TABLE "billing_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"grant_id" text,
	"stripe_dispute_id" text NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"stripe_status" text NOT NULL,
	"outcome" text DEFAULT 'open' NOT NULL,
	"evidence_due_by" timestamp with time zone,
	"funds_reinstated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_disputes_outcome_check" CHECK ("billing_disputes"."outcome" in ('open', 'won', 'lost')),
	CONSTRAINT "billing_disputes_amount_check" CHECK ("billing_disputes"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD CONSTRAINT "billing_disputes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD CONSTRAINT "billing_disputes_grant_id_billing_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."billing_credit_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_disputes" ADD CONSTRAINT "billing_disputes_organization_grant_fk" FOREIGN KEY ("organization_id","grant_id") REFERENCES "public"."billing_credit_grants"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_disputes_organization_id_id_unique" ON "billing_disputes" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_disputes_org_stripe_dispute_unique" ON "billing_disputes" USING btree ("organization_id","stripe_dispute_id");