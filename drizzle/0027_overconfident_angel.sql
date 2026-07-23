CREATE TABLE "billing_auto_recharge_rules" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"pack_catalog_key" text,
	"balance_threshold_units" integer,
	"monthly_cap_cents" integer,
	"state" text DEFAULT 'inactive' NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"consent_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_auto_recharge_rules_state_check" CHECK ("billing_auto_recharge_rules"."state" in ('inactive', 'active', 'paused_needs_auth', 'paused_failed')),
	CONSTRAINT "billing_auto_recharge_rules_cap_check" CHECK ("billing_auto_recharge_rules"."monthly_cap_cents" is null or "billing_auto_recharge_rules"."monthly_cap_cents" <= 100000)
);
--> statement-breakpoint
CREATE TABLE "billing_checkout_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"action" text NOT NULL,
	"catalog_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"consent_versions" jsonb NOT NULL,
	"stripe_checkout_session_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_checkout_attempts_action_check" CHECK ("billing_checkout_attempts"."action" in ('subscription', 'credits')),
	CONSTRAINT "billing_checkout_attempts_status_check" CHECK ("billing_checkout_attempts"."status" in ('open', 'complete', 'expired', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "billing_credit_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"allocated_units" integer NOT NULL,
	"consumed_units" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credit_allocations_units_check" CHECK ("billing_credit_allocations"."allocated_units" >= 0 and "billing_credit_allocations"."consumed_units" >= 0 and "billing_credit_allocations"."consumed_units" <= "billing_credit_allocations"."allocated_units")
);
--> statement-breakpoint
CREATE TABLE "billing_credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"source_reference" text,
	"stripe_payment_reference" text,
	"monthly_window_key" text,
	"original_units" integer NOT NULL,
	"remaining_units" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credit_grants_source_check" CHECK ("billing_credit_grants"."source" in ('subscription_monthly', 'subscription_annual_window', 'pack', 'legacy_manual', 'promotional', 'operator_trial')),
	CONSTRAINT "billing_credit_grants_state_check" CHECK ("billing_credit_grants"."state" in ('active', 'frozen', 'expired', 'revoked')),
	CONSTRAINT "billing_credit_grants_units_check" CHECK ("billing_credit_grants"."original_units" >= 0 and "billing_credit_grants"."remaining_units" >= 0 and "billing_credit_grants"."remaining_units" <= "billing_credit_grants"."original_units")
);
--> statement-breakpoint
CREATE TABLE "billing_credit_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"operation" text NOT NULL,
	"rate_card_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"maximum_units" integer NOT NULL,
	"settled_units" integer,
	"state" text DEFAULT 'reserved' NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"settlement_grace_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_credit_reservations_state_check" CHECK ("billing_credit_reservations"."state" in ('reserved', 'settled', 'released', 'expired')),
	CONSTRAINT "billing_credit_reservations_units_check" CHECK ("billing_credit_reservations"."maximum_units" >= 0 and ("billing_credit_reservations"."settled_units" is null or ("billing_credit_reservations"."settled_units" >= 0 and "billing_credit_reservations"."settled_units" <= "billing_credit_reservations"."maximum_units")))
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"grant_id" text,
	"reservation_id" text,
	"units_delta" integer NOT NULL,
	"source_idempotency_key" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_ledger_entries_entry_type_check" CHECK ("billing_ledger_entries"."entry_type" in ('grant', 'reserve', 'release', 'consume', 'expire', 'freeze', 'unfreeze', 'revoke', 'adjust'))
);
--> statement-breakpoint
CREATE TABLE "billing_provider_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"operation" text NOT NULL,
	"reservation_id" text,
	"provider_request_id" text,
	"units" integer NOT NULL,
	"estimated_cost_cents" integer NOT NULL,
	"actual_cost_cents" integer,
	"currency" text DEFAULT 'usd' NOT NULL,
	"reconciliation_state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_provider_usage_units_check" CHECK ("billing_provider_usage"."units" >= 0),
	CONSTRAINT "billing_provider_usage_reconciliation_check" CHECK ("billing_provider_usage"."reconciliation_state" in ('pending', 'matched', 'mismatched'))
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"counts_checked" jsonb NOT NULL,
	"mismatches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repairs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" text DEFAULT 'clean' NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_reconciliation_runs_result_check" CHECK ("billing_reconciliation_runs"."result" in ('clean', 'mismatches_found', 'repairs_applied'))
);
--> statement-breakpoint
CREATE TABLE "billing_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"subscription_id" text,
	"grant_id" text,
	"requested_by_user_id" text NOT NULL,
	"operator_user_id" text,
	"idempotency_key" text NOT NULL,
	"policy_decision" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"stripe_refund_id" text,
	"revised_service_end_at" timestamp with time zone,
	"credit_revocation_units" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_refunds_policy_check" CHECK ("billing_refunds"."policy_decision" in ('full_unused_pack', 'partial_pack_operator', 'full_subscription_invoice', 'partial_subscription_operator')),
	CONSTRAINT "billing_refunds_state_check" CHECK ("billing_refunds"."state" in ('pending', 'succeeded', 'failed', 'repair_needed')),
	CONSTRAINT "billing_refunds_amount_check" CHECK ("billing_refunds"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_seller_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"legal_name" text NOT NULL,
	"public_business_address" text NOT NULL,
	"establishment_country" text NOT NULL,
	"approved_tax_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"support_email" text NOT NULL,
	"statement_descriptor" text NOT NULL,
	"country_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tax_registrations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_seller_profiles_version_check" CHECK ("billing_seller_profiles"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"catalog_key" text NOT NULL,
	"tier" text NOT NULL,
	"interval" text NOT NULL,
	"catalog_version" integer NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_status" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"scheduled_change" jsonb DEFAULT 'null'::jsonb,
	"grace_period_ends_at" timestamp with time zone,
	"payment_blocked_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"provider_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_tier_check" CHECK ("billing_subscriptions"."tier" in ('pro', 'pro_max', 'team')),
	CONSTRAINT "billing_subscriptions_interval_check" CHECK ("billing_subscriptions"."interval" in ('monthly', 'annual'))
);
--> statement-breakpoint
CREATE TABLE "billing_terms_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"terms_version" text NOT NULL,
	"privacy_version" text NOT NULL,
	"commercial_action" text NOT NULL,
	"reference_id" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_terms_acceptances_action_check" CHECK ("billing_terms_acceptances"."commercial_action" in ('checkout_subscription', 'checkout_credits', 'auto_recharge'))
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_event_id" text NOT NULL,
	"api_version" text NOT NULL,
	"object_type" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"payload_encrypted" text NOT NULL,
	"last_error" text,
	CONSTRAINT "billing_webhook_events_status_check" CHECK ("billing_webhook_events"."status" in ('pending', 'processing', 'processed', 'failed', 'ignored')),
	CONSTRAINT "billing_webhook_events_attempts_check" CHECK ("billing_webhook_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_attempts_organization_id_id_unique" ON "billing_checkout_attempts" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_attempts_org_idempotency_unique" ON "billing_checkout_attempts" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_allocations_organization_id_id_unique" ON "billing_credit_allocations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_allocations_reservation_grant_unique" ON "billing_credit_allocations" USING btree ("reservation_id","grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_grants_organization_id_id_unique" ON "billing_credit_grants" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_grants_monthly_window_unique" ON "billing_credit_grants" USING btree ("monthly_window_key") WHERE "billing_credit_grants"."monthly_window_key" is not null;--> statement-breakpoint
CREATE INDEX "billing_credit_grants_org_state_expiry_idx" ON "billing_credit_grants" USING btree ("organization_id","state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_reservations_organization_id_id_unique" ON "billing_credit_reservations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_reservations_org_idempotency_unique" ON "billing_credit_reservations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_organization_id_id_unique" ON "billing_customers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_org_livemode_unique" ON "billing_customers" USING btree ("organization_id","livemode");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_stripe_customer_id_unique" ON "billing_customers" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_ledger_entries_organization_id_id_unique" ON "billing_ledger_entries" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_ledger_entries_org_source_idempotency_unique" ON "billing_ledger_entries" USING btree ("organization_id","source_idempotency_key");--> statement-breakpoint
CREATE INDEX "billing_ledger_entries_org_created_idx" ON "billing_ledger_entries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_usage_organization_id_id_unique" ON "billing_provider_usage" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "billing_provider_usage_org_created_idx" ON "billing_provider_usage" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "billing_reconciliation_runs_window_idx" ON "billing_reconciliation_runs" USING btree ("window_start","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_refunds_organization_id_id_unique" ON "billing_refunds" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_refunds_org_idempotency_unique" ON "billing_refunds" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_seller_profiles_version_unique" ON "billing_seller_profiles" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_organization_id_id_unique" ON "billing_subscriptions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_stripe_subscription_id_unique" ON "billing_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_org_livemode_active_unique" ON "billing_subscriptions" USING btree ("organization_id","livemode") WHERE "billing_subscriptions"."canceled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_terms_acceptances_organization_id_id_unique" ON "billing_terms_acceptances" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "billing_terms_acceptances_org_action_idx" ON "billing_terms_acceptances" USING btree ("organization_id","commercial_action","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_livemode_stripe_event_id_unique" ON "billing_webhook_events" USING btree ("livemode","stripe_event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_status_next_attempt_idx" ON "billing_webhook_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "billing_auto_recharge_rules" ADD CONSTRAINT "billing_auto_recharge_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_auto_recharge_rules" ADD CONSTRAINT "billing_auto_recharge_rules_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_allocations" ADD CONSTRAINT "billing_credit_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_allocations" ADD CONSTRAINT "billing_credit_allocations_reservation_id_billing_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."billing_credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_allocations" ADD CONSTRAINT "billing_credit_allocations_grant_id_billing_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."billing_credit_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_allocations" ADD CONSTRAINT "billing_credit_allocations_organization_reservation_fk" FOREIGN KEY ("organization_id","reservation_id") REFERENCES "public"."billing_credit_reservations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_allocations" ADD CONSTRAINT "billing_credit_allocations_organization_grant_fk" FOREIGN KEY ("organization_id","grant_id") REFERENCES "public"."billing_credit_grants"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_credit_reservations" ADD CONSTRAINT "billing_credit_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_grant_id_billing_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."billing_credit_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_reservation_id_billing_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."billing_credit_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_organization_grant_fk" FOREIGN KEY ("organization_id","grant_id") REFERENCES "public"."billing_credit_grants"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_ledger_entries" ADD CONSTRAINT "billing_ledger_entries_organization_reservation_fk" FOREIGN KEY ("organization_id","reservation_id") REFERENCES "public"."billing_credit_reservations"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_provider_usage" ADD CONSTRAINT "billing_provider_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_provider_usage" ADD CONSTRAINT "billing_provider_usage_reservation_id_billing_credit_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."billing_credit_reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliation_runs" ADD CONSTRAINT "billing_reconciliation_runs_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."billing_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_grant_id_billing_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."billing_credit_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_requested_by_user_id_auth_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_operator_user_id_auth_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_organization_subscription_fk" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "public"."billing_subscriptions"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_organization_grant_fk" FOREIGN KEY ("organization_id","grant_id") REFERENCES "public"."billing_credit_grants"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_seller_profiles" ADD CONSTRAINT "billing_seller_profiles_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_customer_id_billing_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."billing_customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organization_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."billing_customers"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_terms_acceptances" ADD CONSTRAINT "billing_terms_acceptances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_terms_acceptances" ADD CONSTRAINT "billing_terms_acceptances_actor_user_id_auth_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_users"("id") ON DELETE restrict ON UPDATE no action;