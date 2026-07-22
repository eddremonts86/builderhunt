-- Custom SQL migration file, put your code below! --

-- `setPlatformUserPlan` (the /admin/users grant path) writes only to
-- `plans`/`plan_changes` — nothing had ever kept a user's admin-granted
-- plan in sync with their personal organization's `organization_entitlements`
-- row, the table every actual feature/seat-limit check reads. The two only
-- ever matched by coincidence, when a one-time backfill (`0009`'s
-- `bootstrap_personal_organization`, and the now-completed
-- personal-organizations-v1 backfill) happened to run after the last plan
-- edit. The very next admin plan change silently diverges forever, since
-- both existing writers use `ON CONFLICT ... DO NOTHING`.
--
-- `builderhunt_platform` has no direct grant on `organizations` /
-- `organization_members` / `organization_entitlements` (0012's role only
-- covers plans/plan_changes/plan_requests/incidents/etc) — mirrors
-- `bootstrap_personal_organization`'s SECURITY DEFINER pattern so the write
-- path stays narrow and auditable at the database layer rather than handing
-- the platform role broad entitlement-table access.
CREATE OR REPLACE FUNCTION sync_personal_organization_entitlement(
  subject_user_id text,
  new_tier text,
  new_status text,
  new_seat_limit integer,
  new_current_period_end timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_org_id text;
BEGIN
  IF new_tier NOT IN ('free', 'pro', 'team') THEN
    RAISE EXCEPTION 'invalid tier' USING ERRCODE = '22023';
  END IF;
  IF new_status NOT IN ('active', 'past_due', 'canceled', 'trialing') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  IF new_seat_limit NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid seat limit' USING ERRCODE = '22023';
  END IF;

  -- Personal organization ids are always `org_personal_<hash>`
  -- (see `personalOrganizationId` / `bootstrap_personal_organization`'s own
  -- format check) — matching on the id avoids parsing the `metadata` text
  -- column as JSON inside this function.
  SELECT om.organization_id INTO target_org_id
  FROM organization_members om
  WHERE om.user_id = subject_user_id
    AND om.role = 'owner'
    AND om.organization_id LIKE 'org\_personal\_%'
  LIMIT 1;

  IF target_org_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO organization_entitlements (
    organization_id, tier, status, billing_period, seat_limit, current_period_end, created_at, updated_at
  ) VALUES (
    target_org_id, new_tier, new_status, 'none', new_seat_limit, new_current_period_end, now(), now()
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    tier = excluded.tier,
    status = excluded.status,
    seat_limit = excluded.seat_limit,
    current_period_end = excluded.current_period_end,
    updated_at = now();
END
$$;

REVOKE ALL ON FUNCTION sync_personal_organization_entitlement(text, text, text, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_personal_organization_entitlement(text, text, text, integer, timestamptz) TO builderhunt_platform;
