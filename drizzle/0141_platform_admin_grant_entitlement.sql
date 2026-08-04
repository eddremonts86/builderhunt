-- Custom SQL migration file, put your code below! --
--
-- The operator grant path (`/admin/users` → `repositories/operator-grants.ts`) could not work as the role it
-- actually runs under, and nothing caught it until the browser did.
--
-- `builderhunt_platform` holds **no privilege at all** on `organizations`, `organization_members` or
-- `organization_entitlements` — verified against the live database, not inferred:
--
--   organization_entitlements  builderhunt_app  = SELECT
--   organizations              builderhunt_app  = SELECT
--   organization_members       builderhunt_app  = SELECT
--   (no builderhunt_platform row on any of the three)
--
-- That is deliberate and long-standing: 0022's own comment explains that the platform role's write path to
-- entitlements goes through a SECURITY DEFINER function precisely so it never gets broad access to the table
-- every seat and feature check reads, and 0118 added the read-side counterpart
-- (`platform_admin_user_billing_summary`) for the same reason.
--
-- The rewrite that replaced the legacy per-user `plans` grant with a canonical per-organization one wrote
-- `organization_entitlements` directly through `platformDb`, which answers 42501 for that role. Its unit tests
-- passed because they connect as the migration superuser, which sees no GRANTs and no RLS. The failure surfaced
-- as an e2e test clicking Save on the admin Users page and never seeing the success banner.
--
-- This is the missing write-side function. It is narrow on purpose:
--
-- * **Tiers are `free`/`pro`/`team` only.** A manual grant can never mint `pro_max` — only a real Stripe
--   subscription can (see 30-stripe-billing-platform/tasks.md, which states this explicitly, and
--   `organization_plan_changes`'s own tier CHECK, which encodes it). Enforcing it here means the rule survives
--   a caller that forgets it.
-- * **`billing_period` is hardcoded `none`.** Nothing is being billed on a cycle; a stale `monthly` would make
--   the billing page promise a renewal date that never arrives.
-- * **Seats are the caller's, but bounded.** The table's own CHECK allows 1..10; this rejects anything outside
--   that with a distinguishable error rather than letting the constraint abort the transaction.
-- * **An unknown organization is refused**, so a grant can never create an entitlement row pointing at nothing.
--   The platform role cannot SELECT `organizations` itself, which is why this check has to live in here.
--
-- Error codes are what the repository maps on: `22023` for a rejected argument, `23503` for an organization
-- that does not exist.
CREATE OR REPLACE FUNCTION platform_admin_grant_organization_entitlement(
  p_organization_id text,
  p_tier text,
  p_status text,
  p_seat_limit integer,
  p_notes text,
  p_trial_ends_at timestamptz
) RETURNS TABLE (
  organization_id text,
  tier text,
  status text,
  seat_limit integer,
  notes text,
  trial_ends_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
-- The RETURNS TABLE columns share their names with the table's columns. `use_column` resolves every such
-- reference to the column, which is what the final SELECT wants; the parameters are all `p_`-prefixed, so
-- nothing else is ambiguous.
#variable_conflict use_column
BEGIN
  IF p_tier NOT IN ('free', 'pro', 'team') THEN
    RAISE EXCEPTION 'not a grantable tier: %', p_tier USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('active', 'past_due', 'canceled', 'trialing') THEN
    RAISE EXCEPTION 'invalid status: %', p_status USING ERRCODE = '22023';
  END IF;
  IF p_seat_limit IS NULL OR p_seat_limit NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid seat limit: %', p_seat_limit USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_organization_id) THEN
    RAISE EXCEPTION 'no such organization: %', p_organization_id USING ERRCODE = '23503';
  END IF;

  RETURN QUERY
  WITH granted AS (
    INSERT INTO organization_entitlements (
      organization_id, tier, status, billing_period, seat_limit, notes, trial_ends_at, created_at, updated_at
    ) VALUES (
      p_organization_id, p_tier, p_status, 'none', p_seat_limit, p_notes, p_trial_ends_at, now(), now()
    )
    ON CONFLICT (organization_id) DO UPDATE SET
      tier = excluded.tier,
      status = excluded.status,
      billing_period = 'none',
      seat_limit = excluded.seat_limit,
      -- Both cleared when not supplied, never preserved: a re-grant that silently kept an old expiry would end
      -- a customer's access on a date the operator thought they had removed.
      notes = excluded.notes,
      trial_ends_at = excluded.trial_ends_at,
      updated_at = now()
    RETURNING
      organization_entitlements.organization_id AS granted_organization_id,
      organization_entitlements.tier AS granted_tier,
      organization_entitlements.status AS granted_status,
      organization_entitlements.seat_limit AS granted_seat_limit,
      organization_entitlements.notes AS granted_notes,
      organization_entitlements.trial_ends_at AS granted_trial_ends_at
  )
  SELECT
    granted.granted_organization_id,
    granted.granted_tier,
    granted.granted_status,
    granted.granted_seat_limit,
    granted.granted_notes,
    granted.granted_trial_ends_at
  FROM granted;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform_admin_grant_organization_entitlement(text, text, text, integer, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform_admin_grant_organization_entitlement(text, text, text, integer, text, timestamptz) TO builderhunt_platform;
