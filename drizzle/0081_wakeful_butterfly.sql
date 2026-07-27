-- Canonical tenant cutover (plan: security-and-multitenancy, task 17).
--
-- These seven tables predate multi-tenancy: `organization_id` was added
-- alongside the original `user_id` during the expand phase and left nullable so
-- old rows could survive until the backfill caught up. Every write path has set
-- it for a long time (each repository takes a required `organizationId` and runs
-- inside `withTenantContext`), and the RLS policies already assume a non-null
-- tenant, so the column can finally carry the constraint.
--
-- `abuse_signals` also allows a null `organization_id` and is deliberately left
-- alone: it is operational telemetry with no owning subject, and a signal raised
-- before authentication has no organization to attribute.
--
-- The composite (organization_id, id) foreign keys this cutover was meant to add
-- are already in place from the expand phase — verified against pg_constraint —
-- so nothing here re-creates them.
--
-- This migration adopts leftover rows itself rather than trusting that
-- `pnpm db:backfill:resources` ran first. Deploy applies migrations as a fatal
-- step (docs/operations/deploy-runbook.md), so an ordering mistake would
-- otherwise take the release down and skip role-password provisioning. The
-- standalone backfill script is still the primary mechanism — it batches, tracks
-- runs, and records conflicts for disposition — and on an already-backfilled
-- database every statement below is a no-op.

SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint

DO $$
DECLARE
  target text;
  forced boolean;
  adopted bigint;
  -- Parents first: a child's tenant is derived from its parent below, and the
  -- composite (organization_id, parent_id) foreign keys require the parent to
  -- already carry its own.
  roots text[] := ARRAY['builders', 'saved_queries', 'onboarding_progress', 'alerts'];
  children text[][] := ARRAY[
    -- child, parent, join predicate
    ARRAY['alert_triggers', 'alerts', 'p.id = t.alert_id'],
    ARRAY['builder_notes', 'builders', 'p.id = t.builder_id'],
    ARRAY['onboarding_selected_builders', 'onboarding_progress', 'p.user_id = t.user_id']
  ];
  child text[];
BEGIN
  -- `FORCE ROW LEVEL SECURITY` applies to the table owner too, and the
  -- migration identity has no tenant policy of its own, so an UPDATE here would
  -- silently match zero rows. Each loop below lifts it for one table and
  -- restores it immediately; a failure anywhere rolls the whole migration back,
  -- FORCE included.
  --
  -- Roots: a row with no tenant belongs to its creator's personal workspace,
  -- which is the single organization they own whose id carries the
  -- `org_personal_` prefix minted by bootstrap_personal_organization (0009).
  FOREACH target IN ARRAY roots
  LOOP
    SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = target::regclass;
    IF forced THEN EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', target); END IF;

    -- The update target cannot be referenced from a JOIN condition in the FROM
    -- clause, so the correlation to `t` lives in WHERE.
    EXECUTE format($fmt$
      UPDATE %I AS t
      SET organization_id = o.id
      FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
      WHERE t.organization_id IS NULL
        AND m.user_id = t.user_id
        AND m.role = 'owner'
        AND left(o.id, 13) = 'org_personal_'
    $fmt$, target);
    GET DIAGNOSTICS adopted = ROW_COUNT;
    IF adopted > 0 THEN
      RAISE NOTICE 'tenant cutover: adopted % row(s) into a personal workspace in %', adopted, target;
    END IF;

    IF forced THEN EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target); END IF;
  END LOOP;

  -- Children: take the parent's tenant verbatim so the composite foreign keys
  -- hold by construction instead of being re-derived and hoping they agree.
  FOREACH child SLICE 1 IN ARRAY children
  LOOP
    SELECT relforcerowsecurity INTO forced FROM pg_class WHERE oid = child[1]::regclass;
    IF forced THEN EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', child[1]); END IF;

    EXECUTE format($fmt$
      UPDATE %I AS t
      SET organization_id = p.organization_id
      FROM %I AS p
      WHERE t.organization_id IS NULL
        AND p.organization_id IS NOT NULL
        AND %s
    $fmt$, child[1], child[2], child[3]);
    GET DIAGNOSTICS adopted = ROW_COUNT;
    IF adopted > 0 THEN
      RAISE NOTICE 'tenant cutover: adopted % row(s) from % in %', adopted, child[2], child[1];
    END IF;

    IF forced THEN EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', child[1]); END IF;
  END LOOP;
END
$$;--> statement-breakpoint

-- Anything still without a tenant cannot be resolved automatically: its creator
-- has no personal workspace, or its parent is itself orphaned. Name it rather
-- than letting Postgres surface a bare constraint violation on whichever table
-- it happened to reach first.
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
    RAISE EXCEPTION 'Tenant cutover blocked: rows without a resolvable organization remain in % — inspect them and run pnpm db:backfill:resources', offending
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
