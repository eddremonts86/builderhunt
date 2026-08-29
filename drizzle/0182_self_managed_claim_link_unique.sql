-- One verified claim backs at most one self-managed profile (plan:
-- phase-2/07-perfiles-autogestionados, "Implement reversible promotion to a verified claim").
--
-- Without this a person could point two live profiles at the same claim, and both would render the
-- verified block from it. A reader has no way to tell which one the claim actually describes, and
-- the honest answer is that neither does — a verified badge that appears on two pages has stopped
-- meaning "this account was proven" and started meaning "somebody said so twice".
--
-- Partial on live rows, matching `self_managed_profiles_handle_live_unique` and `..._owner_live_unique`
-- and for the same reason: a soft-deleted profile must not hold a claim hostage for thirty days,
-- and the error would read "already linked" about a link nobody can see.
--
-- The repository checks first so the common case gets a message naming the problem; this is what
-- holds under two concurrent requests, and 23505 is translated back into `claim-already-linked`.
CREATE UNIQUE INDEX "self_managed_profiles_claim_live_unique"
  ON "self_managed_profiles" ("promoted_to_builder_claim_id")
  WHERE "promoted_to_builder_claim_id" IS NOT NULL AND "deleted_at" IS NULL;
