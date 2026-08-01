-- Custom SQL migration file, put your code below! --
-- plans/phase-1/43-solutions-intelligence Phase 3, "Dual-read/write organization tracking".
--
-- Step one of an additive cutover. `builder_identity_id` remains the authoritative key; this column
-- is a nullable second pointer that dual-writes alongside it, so old and new reads can be compared
-- before anything switches over. Every row is NULL until the backfill runs, and every existing read
-- keeps working with it NULL — that is what makes this deployable ahead of its consumers.
--
-- ON DELETE SET NULL, not CASCADE. `organization_builders` is tenant-private and holds an
-- organization's own notes, status and private metadata; `canonical_humans` is global-public and can
-- be deleted or unmerged by a platform action. A cascade would let a global identity decision destroy
-- a tenant's private tracking, which is both a data-loss bug and a tenant-isolation violation. With
-- SET NULL the tenant keeps its record and loses only the pointer, which is also precisely what makes
-- a cutover reversible: revert the code and the rows are still valid under the old key.
ALTER TABLE "organization_builders"
  ADD COLUMN "canonical_human_id" text;

ALTER TABLE "organization_builders"
  ADD CONSTRAINT "organization_builders_canonical_human_id_canonical_humans_id_fk"
  FOREIGN KEY ("canonical_human_id") REFERENCES "canonical_humans"("id") ON DELETE SET NULL;

-- Composite with organization_id, not a bare index on the column: every tenant-scoped read is
-- already filtered by organization under RLS, and the parity check scans per organization.
CREATE INDEX "organization_builders_canonical_human_idx"
  ON "organization_builders" ("organization_id", "canonical_human_id");

-- No new grants needed: `organization_builders` already grants the app and worker roles the
-- INSERT/UPDATE they use, and a column inherits its table's privileges. Verified against
-- information_schema.role_table_grants rather than assumed — the lesson from 0123, where
-- `builder_source_snapshots` turned out to have no role grants at all and every write failed 42501.
