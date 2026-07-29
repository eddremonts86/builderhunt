ALTER TABLE "builder_profile_views" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "builder_source_snapshots" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "enrichment_evidence" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "migration_backfill_conflicts" ALTER COLUMN "id" SET DEFAULT uuidv7();