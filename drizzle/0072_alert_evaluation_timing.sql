ALTER TABLE "alerts" ADD COLUMN "next_evaluation_at" timestamp;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "last_evaluation_error_code" text;--> statement-breakpoint
CREATE INDEX "alerts_next_evaluation_idx" ON "alerts" USING btree ("enabled","next_evaluation_at");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_consecutive_failures_check" CHECK ("alerts"."consecutive_failures" >= 0);