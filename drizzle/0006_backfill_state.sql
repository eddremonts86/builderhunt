CREATE TABLE "migration_backfill_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_name" text NOT NULL,
	"source_table" text NOT NULL,
	"source_id" text NOT NULL,
	"reason" text NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "migration_backfill_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor" text,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"migrated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"conflict_count" integer DEFAULT 0 NOT NULL,
	"orphan_count" integer DEFAULT 0 NOT NULL,
	"checksum" text,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "migration_backfill_runs_status_check" CHECK ("migration_backfill_runs"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "migration_backfill_runs_counts_check" CHECK ("migration_backfill_runs"."processed_count" >= 0 and "migration_backfill_runs"."migrated_count" >= 0 and "migration_backfill_runs"."skipped_count" >= 0 and "migration_backfill_runs"."conflict_count" >= 0 and "migration_backfill_runs"."orphan_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "migration_backfill_conflicts" ADD CONSTRAINT "migration_backfill_conflicts_run_name_migration_backfill_runs_name_fk" FOREIGN KEY ("run_name") REFERENCES "public"."migration_backfill_runs"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_backfill_conflicts_source_reason_unique" ON "migration_backfill_conflicts" USING btree ("run_name","source_table","source_id","reason");--> statement-breakpoint
CREATE INDEX "migration_backfill_conflicts_unresolved_idx" ON "migration_backfill_conflicts" USING btree ("run_name","resolved_at");