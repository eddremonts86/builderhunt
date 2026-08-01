-- `builder_profile_views.builder_id` has referenced the legacy per-organization `builders` table
-- since migration 0000, from before the 0005 builder-normalization split introduced
-- `builder_identities`/`organization_builders`. Every real caller (the views API route,
-- `isVerifiedBuilderClaimant`, the public /builders/$builderId page, `builder_claims`,
-- `published_builder_profiles`) addresses a builder by its identity id — the old FK made every
-- write to this table fail with a foreign-key violation for any current builder identity.
--
-- No production traffic could have relied on the old FK target: any insert against it would have
-- 500'd for every real builder identity, so there is nothing to migrate forward, only rows (if any
-- ever landed against a legacy `builders.id` coincidentally) that would now orphan under the new
-- target — delete them first so the new constraint can attach cleanly.
DELETE FROM "builder_profile_views"
WHERE "builder_id" NOT IN (SELECT "id" FROM "builder_identities");
--> statement-breakpoint
ALTER TABLE "builder_profile_views" DROP CONSTRAINT "builder_profile_views_builder_id_builders_id_fk";
--> statement-breakpoint
ALTER TABLE "builder_profile_views" ADD CONSTRAINT "builder_profile_views_builder_id_builder_identities_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builder_identities"("id") ON DELETE cascade ON UPDATE no action;
