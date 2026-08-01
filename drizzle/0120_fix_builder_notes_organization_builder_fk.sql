-- Custom SQL migration file, put your code below! --
-- `builder_notes.builder_id` has referenced the legacy `builders` table since the table was
-- created, but nothing in the current codebase ever inserts into `builders` anymore — it was
-- superseded by `builder_identities`/`organization_builders`. `POST /api/builders/$builderId/notes`
-- (src/routes/api/builders/$builderId/notes.ts) resolves `params.builderId` via
-- `resolveOrganizationBuilderId`, which returns an `organization_builders.id`, then tries to insert
-- that id as `builder_notes.builder_id` — violating this stale FK on every single call. Confirmed
-- empirically 2026-08-01: `select count(*) from builder_notes` returns 0 in the local dev DB, and
-- `tests/e2e/api/cross-tenant.spec.ts` already works around this by seeding a duplicate "shadow"
-- row into `builders` with the same id as the `organization_builders` row purely to satisfy this FK.
--
-- Repoints both the single-column and composite FKs at `organization_builders`, mirroring the exact
-- pattern `scheduling_invitations_organization_builder_fk` already uses for the same table pair.
ALTER TABLE "builder_notes" DROP CONSTRAINT "builder_notes_builder_id_builders_id_fk";
ALTER TABLE "builder_notes" DROP CONSTRAINT "builder_notes_organization_builder_fk";

ALTER TABLE "builder_notes" ADD CONSTRAINT "builder_notes_builder_id_organization_builders_id_fk"
  FOREIGN KEY ("builder_id") REFERENCES "organization_builders"("id");

ALTER TABLE "builder_notes" ADD CONSTRAINT "builder_notes_organization_builder_fk"
  FOREIGN KEY ("organization_id", "builder_id") REFERENCES "organization_builders"("organization_id", "id");
