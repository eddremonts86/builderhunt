-- Plan 37 (portfolio-builder): the public portfolio page (GET /api/portfolio/$claimId ->
-- getPublicPortfolioClaim) reads a builder_claims row anonymously, joined to builder_identities,
-- filtered to status = 'verified'. `0011_builder_claim_policies.sql`'s only SELECT policy
-- (builder_claims_app_select) requires `subject_user_id = app.user_id`, which is correct for "the
-- claim owner reads their own claim" but structurally forbids the anonymous cross-user read the
-- public portfolio page needs — every visit 404'd regardless of whether the claim was genuinely
-- verified and published. Found 2026-07-31 during a phase-1 feature audit; confirmed empirically
-- (SET ROLE builderhunt_app with no app.user_id, inside a rolled-back transaction) that a real
-- verified claim was invisible.
--
-- This policy is additive: it does not touch builder_claims_app_select, builder_claims_app_insert,
-- or builder_claims_app_update, so an unverified (pending/rejected/revoked/expired) claim remains
-- visible only to its owner. The `status = 'verified'` predicate mirrors the same filter
-- getPublicPortfolioClaim already applies at the query layer — this is defense in depth, not a
-- widening of what the route already exposes.
CREATE POLICY "builder_claims_public_portfolio_select" ON "builder_claims"
  FOR SELECT TO "builderhunt_app"
  USING (status = 'verified');
