-- Narrow atomic bootstrap used only by Better Auth after account creation.
-- The auth broker receives EXECUTE, never direct entitlement table access.
CREATE OR REPLACE FUNCTION bootstrap_personal_organization(
  subject_user_id text,
  personal_organization_id text,
  personal_organization_slug text,
  owner_member_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF personal_organization_id !~ '^org_personal_[0-9a-f]{24}$'
    OR personal_organization_slug !~ '^personal-[0-9a-f]{24}$'
    OR owner_member_id <> personal_organization_id || ':owner'
  THEN
    RAISE EXCEPTION 'invalid personal organization identifiers' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.auth_users WHERE id = subject_user_id) THEN
    RAISE EXCEPTION 'account subject not found' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.organizations (id, name, slug, metadata, created_at)
  VALUES (personal_organization_id, 'Personal workspace', personal_organization_slug, '{"kind":"personal","version":1}', now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organization_members (id, organization_id, user_id, role, created_at)
  VALUES (owner_member_id, personal_organization_id, subject_user_id, 'owner', now())
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  INSERT INTO public.organization_entitlements (
    organization_id, tier, status, billing_period, seat_limit, created_at, updated_at
  ) VALUES (personal_organization_id, 'free', 'active', 'none', 1, now(), now())
  ON CONFLICT (organization_id) DO NOTHING;
END
$$;

REVOKE ALL ON FUNCTION bootstrap_personal_organization(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_personal_organization(text, text, text, text) TO builderhunt_auth;
