-- Custom SQL migration file, put your code below! --
-- plans/UI/tasks.md Wave 7 "Add opt-in AI persona to public portfolios".
--
-- The public portfolio page (GET /portfolio/$claimId) reads anonymously, via `builderhunt_app` with
-- no `app.organization_id`/`app.user_id` session context set — the same structural gap `0111`
-- already fixed for `builder_claims`. `organization_builders` is tenant-scoped (its SELECT RLS
-- policy requires `organization_id = app.organization_id`), so an anonymous read of
-- `organization_builders.private_metadata->'aiEnrichment'` for the AI persona feature returns zero
-- rows even when a matching row genuinely exists — confirmed empirically 2026-08-01 the same way
-- 0111's own comment describes.
--
-- Unlike 0111 (a session-context match: "the claim owner reads their own claim"), this check is
-- against a query PARAMETER (the claim's own `subject_user_id`, already resolved by the caller from
-- a verified claim) rather than session state — an anonymous visitor has no session at all, so a
-- plain additive RLS policy keyed on `app.user_id` cannot express "this row was created by the
-- person this claim names," only a function argument can. Hence a SECURITY DEFINER function, same
-- pattern as `platform_admin_user_billing_summary` (0118) and `sync_personal_organization_entitlement`
-- (0022): narrowly scoped to exactly the (builder_identity_id, creator_user_id) pair the caller
-- already knows, returning only the one jsonb key the feature needs — never the whole
-- private_metadata column, never any other organization's row for the same shared identity.
CREATE OR REPLACE FUNCTION public_claimant_owned_ai_enrichment(p_builder_identity_id text, p_subject_user_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT private_metadata -> 'aiEnrichment'
  FROM organization_builders
  WHERE builder_identity_id = p_builder_identity_id
    AND creator_user_id = p_subject_user_id
  ORDER BY updated_at DESC
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public_claimant_owned_ai_enrichment(text, text) TO builderhunt_app;
