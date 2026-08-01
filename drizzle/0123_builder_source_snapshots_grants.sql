-- Custom SQL migration file, put your code below! --
-- plans/phase-1/43-solutions-intelligence Phase 3, "Persist approved source observations".
--
-- `builder_source_snapshots` was created with a schema, a unique index and a cascade FK, and with
-- **no role grants at all** — only the `postgres` owner could touch it. Verified 2026-08-01:
--
--   select grantee, privilege_type from information_schema.role_table_grants
--     where table_name = 'builder_source_snapshots';
--   -> postgres only
--
-- Which is why the table had 0 rows: any write as `builderhunt_app` failed with
-- "permission denied for table builder_source_snapshots". The table was unreachable, not merely
-- unused, and nothing caught it because no code path wrote to it and disposable-database tests run
-- as superuser (see the note in tests/unit/security/source-observations.test.ts).
--
-- Grants mirror `builder_identities` (drizzle/0011, 0018), which is the table this one annotates.

-- The write-through runs on the request path through `publicDb`, i.e. as the app role — the same
-- role that already inserts and updates `builder_identities` during ingestion.
--
-- SELECT is required in addition to INSERT, and not only for reads: the insert uses
-- `... ON CONFLICT DO NOTHING RETURNING id` to distinguish a new observation from an unchanged one,
-- and RETURNING needs SELECT even when the plain INSERT alone would be permitted.
GRANT SELECT, INSERT ON TABLE "builder_source_snapshots" TO "builderhunt_app";

-- The discovery worker ingests through the same write-through path.
GRANT SELECT, INSERT ON TABLE "builder_source_snapshots" TO "builderhunt_worker";

-- No UPDATE for either role: a snapshot is an immutable observation of what a source said at a
-- point in time. Correcting one in place would destroy the history the table exists to hold.
--
-- DELETE goes to the platform role only, for purging a subject's observations on a removal or
-- restriction request — the same shape as the evidence purge in
-- `cascadeBuilderProcessingRestriction`. Ordinary ingestion must never be able to delete history.
GRANT SELECT, DELETE ON TABLE "builder_source_snapshots" TO "builderhunt_platform";
