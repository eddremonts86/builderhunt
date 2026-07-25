-- abuse-and-usage-integrity Phase 4B "G6" — adds the `credit_spend_velocity` signal type for the
-- first-payer credit-consumption cap. No existing rows are affected; widens the CHECK constraint only.
ALTER TABLE "abuse_signals" DROP CONSTRAINT "abuse_signals_type_check";--> statement-breakpoint
ALTER TABLE "abuse_signals" ADD CONSTRAINT "abuse_signals_type_check" CHECK ("abuse_signals"."type" in (
        'concurrent_sessions', 'impossible_travel', 'ua_change', 'seat_overuse',
        'signup_velocity', 'linked_account', 'export_burst', 'cross_tenant_denied',
        'credit_farming', 'pool_drain', 'refund_farming', 'margin_drift', 'reserve_leak',
        'credit_spend_velocity'
      ));
