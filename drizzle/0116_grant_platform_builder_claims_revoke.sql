-- plans/UI/tasks.md Wave 4 "Build Admin Claims UI and revocation flow".
--
-- `POST /api/admin/builder-claims/$claimId/revoke` has called `revokeBuilderClaim(publicDb, ...)`
-- since it was first built, but `publicDb` connects as `builderhunt_app`, whose only UPDATE policy
-- on builder_claims (0011_builder_claim_policies.sql, `builder_claims_app_update`) requires
-- `subject_user_id = app.user_id` — the claim's OWNER updating their own row. A platform admin is
-- never that owner, so the UPDATE's WHERE clause always matched zero rows: every revoke silently
-- no-op'd with "No active verified claim found for that id", regardless of a real verified claim
-- existing. Found 2026-08-01 driving the real admin UI end to end (the SELECT side worked, thanks to
-- 0111_builder_claims_public_portfolio_select.sql's additive `status = 'verified'` policy, which
-- made the claim visible in the list — masking that revoke itself was completely inert).
--
-- Fix: route the revoke write through `platformDb` (builderhunt_platform) instead, the connection
-- this codebase already reserves for platform-admin-gated writes — never granted here before
-- because nothing needed to write to this table from that role until now. The new policy is scoped
-- exactly like `revokeBuilderClaim`'s own query (verified -> revoked only), so this is strictly
-- narrower than the owner's own update policy, not a widening of who can touch what.
--
-- SELECT is granted too, alongside UPDATE — confirmed live (has_table_privilege said UPDATE was
-- fine, the bare UPDATE still 42501'd) that `UPDATE ... RETURNING` needs SELECT on top of UPDATE,
-- same lesson already on file for this app's write-only roles (see project memory
-- returning-clause-needs-select-grant): `revokeBuilderClaim` does `.returning({ id, ... })`.
CREATE POLICY "builder_claims_platform_revoke" ON "builder_claims"
  FOR UPDATE TO "builderhunt_platform"
  USING (status = 'verified')
  WITH CHECK (status = 'revoked');
--> statement-breakpoint
CREATE POLICY "builder_claims_platform_select" ON "builder_claims"
  FOR SELECT TO "builderhunt_platform"
  USING (status in ('verified', 'revoked'));
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "builder_claims" TO "builderhunt_platform";
