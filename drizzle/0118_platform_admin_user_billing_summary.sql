-- Custom SQL migration file, put your code below! --
-- plans/UI/tasks.md Wave 5 "Align Admin Users with organization-owned billing".
--
-- `builderhunt_platform` deliberately has no direct SELECT on organizations/organization_members/
-- organization_entitlements/billing_subscriptions (see 0022's own comment on this) — the write path
-- for admin plan grants already goes through a SECURITY DEFINER function
-- (sync_personal_organization_entitlement) for the same reason. This adds the read-side
-- counterpart: one row per user's owned organization (there is at most one, enforced by
-- organization_members' partial unique index on role = 'owner'), with just enough to distinguish
-- canonical-paid (a live, non-canceled billing_subscriptions row) from a manually-granted
-- entitlement (a non-free tier with no such row) — never a raw Stripe id or payload.
CREATE OR REPLACE FUNCTION platform_admin_user_billing_summary(p_user_id text)
RETURNS TABLE (
  organization_id text,
  organization_name text,
  tier text,
  status text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  has_active_subscription boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    o.id AS organization_id,
    o.name AS organization_name,
    coalesce(oe.tier, 'free') AS tier,
    coalesce(oe.status, 'active') AS status,
    oe.current_period_end,
    oe.trial_ends_at,
    EXISTS (
      SELECT 1 FROM billing_subscriptions bs
      WHERE bs.organization_id = o.id AND bs.canceled_at IS NULL
    ) AS has_active_subscription
  FROM organization_members om
  JOIN organizations o ON o.id = om.organization_id
  LEFT JOIN organization_entitlements oe ON oe.organization_id = o.id
  WHERE om.user_id = p_user_id AND om.role = 'owner'
  ORDER BY o.created_at ASC
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION platform_admin_user_billing_summary(text) TO builderhunt_platform;
