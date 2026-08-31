ALTER TABLE "user_preferences" ADD COLUMN "search_include_self_managed" boolean;--> statement-breakpoint

-- Nullable on purpose, and `null` is not `false` (plan: phase-2/07-perfiles-autogestionados,
-- "Apply the shared inclusion policy to every current matching surface").
--
-- `null` means the person never expressed a preference, and it resolves to *included* — the spec's
-- coverage rule is that self-managed profiles are filterable but never hidden by default. Storing
-- the default as a real `false` would make "never asked" and "asked to be excluded" the same row,
-- and a later change of default would then have to overwrite the choice of everyone who did ask.
--
-- No backfill for the same reason: every existing row keeps `null` and keeps meaning "never asked".
