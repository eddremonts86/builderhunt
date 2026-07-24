CREATE TABLE "abuse_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"details" jsonb,
	"user_id" text,
	"organization_id" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "abuse_signals_type_check" CHECK ("abuse_signals"."type" in (
        'concurrent_sessions', 'impossible_travel', 'ua_change', 'seat_overuse',
        'signup_velocity', 'linked_account', 'export_burst', 'cross_tenant_denied',
        'credit_farming', 'pool_drain', 'refund_farming', 'margin_drift', 'reserve_leak'
      )),
	CONSTRAINT "abuse_signals_severity_check" CHECK ("abuse_signals"."severity" in ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "account_risk" (
	"user_id" text PRIMARY KEY NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"stage" text DEFAULT 'observe' NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_risk_stage_check" CHECK ("account_risk"."stage" in ('observe', 'warned', 'stepup', 'throttled', 'blocked')),
	CONSTRAINT "account_risk_score_check" CHECK ("account_risk"."risk_score" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seat_usage_daily" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"day" text NOT NULL,
	"action" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"credit_units" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "seat_usage_daily_action_check" CHECK ("seat_usage_daily"."action" in ('searches', 'reveals', 'exports', 'messages')),
	CONSTRAINT "seat_usage_daily_count_check" CHECK ("seat_usage_daily"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "session_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id_hash" text NOT NULL,
	"device_id" text,
	"ip_asn" text,
	"country" text,
	"new_device" boolean DEFAULT false NOT NULL,
	"concurrent_distinct_ip" boolean DEFAULT false NOT NULL,
	"impossible_travel" boolean DEFAULT false NOT NULL,
	"mid_session_ua_change" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_hash" text NOT NULL,
	"ua_family" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ip_asn" text,
	"last_country" text,
	"trust_state" text DEFAULT 'new' NOT NULL,
	CONSTRAINT "user_devices_trust_state_check" CHECK ("user_devices"."trust_state" in ('new', 'trusted', 'flagged'))
);
--> statement-breakpoint
ALTER TABLE "account_risk" ADD CONSTRAINT "account_risk_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_usage_daily" ADD CONSTRAINT "seat_usage_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_usage_daily" ADD CONSTRAINT "seat_usage_daily_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_device_id_user_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_signals_user_id_created_idx" ON "abuse_signals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "abuse_signals_organization_id_created_idx" ON "abuse_signals" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "abuse_signals_type_created_idx" ON "abuse_signals" USING btree ("type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seat_usage_daily_org_user_day_action_unique" ON "seat_usage_daily" USING btree ("organization_id","user_id","day","action");--> statement-breakpoint
CREATE INDEX "seat_usage_daily_organization_id_day_idx" ON "seat_usage_daily" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "session_signals_session_id_hash_idx" ON "session_signals" USING btree ("session_id_hash");--> statement-breakpoint
CREATE INDEX "session_signals_created_at_idx" ON "session_signals" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_user_id_device_hash_unique" ON "user_devices" USING btree ("user_id","device_hash");--> statement-breakpoint
CREATE INDEX "user_devices_user_id_last_seen_idx" ON "user_devices" USING btree ("user_id","last_seen_at");