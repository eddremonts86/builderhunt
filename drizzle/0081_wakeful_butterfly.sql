-- Canonical tenant cutover (plan: security-and-multitenancy, task 17).
--
-- These seven tables predate multi-tenancy: `organization_id` was added
-- alongside the original `user_id` during the expand phase and left nullable so
-- old rows could survive until the backfill caught up. Every write path has set
-- it for a long time (each repository takes a required `organizationId` and runs
-- inside `withTenantContext`), and `scripts/db/backfills/resources.ts` closes the
-- historical rows, so the column can finally carry the constraint the RLS
-- policies already assume.
--
-- `abuse_signals` also allows a null `organization_id` and is deliberately left
-- alone: it is operational telemetry with no owning subject, and a signal raised
-- before authentication has no organization to attribute.
--
-- The composite (organization_id, id) foreign keys this cutover was meant to add
-- are already in place from the expand phase — verified against pg_constraint —
-- so nothing here re-creates them.
--
-- Run `pnpm db:backfill:resources` before deploying this. The guard below turns a
-- forgotten backfill into a named, actionable error instead of a bare constraint
-- violation on whichever table Postgres happened to reach first.

SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(format('%s (%s rows)', source, n), ', ' ORDER BY source)
  INTO offending
  FROM (
    SELECT 'alert_triggers' AS source, count(*) AS n FROM alert_triggers WHERE organization_id IS NULL
    UNION ALL SELECT 'alerts', count(*) FROM alerts WHERE organization_id IS NULL
    UNION ALL SELECT 'builder_notes', count(*) FROM builder_notes WHERE organization_id IS NULL
    UNION ALL SELECT 'builders', count(*) FROM builders WHERE organization_id IS NULL
    UNION ALL SELECT 'onboarding_progress', count(*) FROM onboarding_progress WHERE organization_id IS NULL
    UNION ALL SELECT 'onboarding_selected_builders', count(*) FROM onboarding_selected_builders WHERE organization_id IS NULL
    UNION ALL SELECT 'saved_queries', count(*) FROM saved_queries WHERE organization_id IS NULL
  ) counts
  WHERE n > 0;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Tenant cutover blocked: rows without an organization remain in % — run pnpm db:backfill:resources first', offending
      USING ERRCODE = '23502';
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "alert_triggers" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "builder_notes" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "builders" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "onboarding_selected_builders" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_queries" ALTER COLUMN "organization_id" SET NOT NULL;
