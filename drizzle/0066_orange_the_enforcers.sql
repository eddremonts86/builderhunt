CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid,
	"job_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_state_check" CHECK ("job_runs"."state" in ('scheduled', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "job_runs_counters_check" CHECK ("job_runs"."processed_count" >= 0 and "job_runs"."failed_count" >= 0 and ("job_runs"."duration_ms" is null or "job_runs"."duration_ms" >= 0)),
	CONSTRAINT "job_runs_finished_check" CHECK ("job_runs"."finished_at" is null or "job_runs"."started_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "operational_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_key" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text NOT NULL,
	"scope" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_schedules_scope_check" CHECK ("operational_schedules"."scope" in ('platform', 'organization'))
);
--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_schedule_id_operational_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."operational_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_runs_job_key_scheduled_idx" ON "job_runs" USING btree ("job_key","scheduled_for");--> statement-breakpoint
CREATE INDEX "job_runs_state_idx" ON "job_runs" USING btree ("state","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_schedules_job_key_unique" ON "operational_schedules" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "operational_schedules_next_run_idx" ON "operational_schedules" USING btree ("enabled","next_run_at");