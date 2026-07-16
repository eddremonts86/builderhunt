-- Smart Alerts (Plan: smart-alerts)
-- Adds trigger conditions and delivery channel to existing alerts table

ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "trigger_conditions" jsonb DEFAULT '{"eventType":"any_activity"}'::jsonb NOT NULL;
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "delivery_channel" text DEFAULT 'email';
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "last_triggered_at" timestamp with time zone;
