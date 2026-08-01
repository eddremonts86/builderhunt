-- Custom SQL migration file, put your code below! --
-- Lets the runtime roles use the `vector` type at all.
--
-- ## What this fixes, and what it does not
--
-- Migration `0002_database_roles.sql` hardens the schema with, among others:
--
--     REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
--
-- pgvector installs its operator implementations into `public`, so that statement is aimed at exactly the
-- functions the `vector` type needs to work. **It happens not to hit them on a clean migration chain**, and the
-- reason is ordering: `0002` runs before `0013` creates the extension, so there are no vector functions to
-- revoke from yet, and pgvector's default `EXECUTE TO PUBLIC` survives. Verified on a freshly migrated
-- database — `cosine_distance` keeps its `=X/postgres` ACL entry and `builderhunt_app` can execute it.
--
-- So this is not a production outage, and an earlier draft of this comment wrongly said it was.
--
-- It *is* a real failure in any database where the revoke landed after the extension existed. That is the
-- state of this repository's development database, reached through some reset or restore sequence, and there
-- the symptom is stark when measured as the real `builderhunt_app` role:
--
--     select count(*) from builder_embeddings                          -- works
--     select ... order by embedding <=> '[...]'::vector                -- ERROR: permission denied
--                                                                      --        for function cosine_distance
--     insert ... on conflict do update set embedding = case ... end    -- ERROR: permission denied
--                                                                      --        for function vector
--
-- Reading the column needs no function, which is why nothing looked broken: the table filled up, row counts
-- were plausible, and every query touching a vector *operator* failed at runtime into a `.catch()` on a
-- fire-and-forget write-through. `builder_embeddings` held 430 catalog rows and **zero** `human_profile` rows
-- despite 247 person identities, because the person write-through is the path that evaluates a `vector`
-- expression while the catalog projector writes `embedding = null` literally and never touches an operator.
--
-- The grant is therefore worth making explicit rather than depending on PUBLIC keeping a privilege that `0002`
-- exists to remove. If that revoke is ever re-run, or a future hardening pass repeats it, semantic search
-- keeps working instead of silently dying.
--
-- Every test in this repository connects as superuser through a disposable database, so none of them could see
-- the broken state either way. `scripts/db/verify-rls-local.mjs` runs as the real roles and now asserts a
-- distance operator actually evaluates.
--
-- ## Why the grant is scoped this way
--
-- Not `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public` — that would re-grant the application functions 0002
-- deliberately locked down, undoing a security decision to fix an unrelated one.
--
-- Instead, exactly the functions belonging to the `vector` extension, found through `pg_depend`. An
-- extension's operator implementations are not application code: they are how a column type works, and any
-- role that may read the column must be able to execute them or the column is decorative. Written as a loop
-- so it stays correct across pgvector versions, which add and rename functions between releases.
--
-- `ALTER DEFAULT PRIVILEGES` is deliberately not used: it would apply to future functions created by whoever
-- runs this migration, which is a much broader statement than "this extension's operators are usable".

DO $$
DECLARE
  extension_oid oid;
  function_signature text;
  granted_count integer := 0;
BEGIN
  SELECT oid INTO extension_oid FROM pg_extension WHERE extname = 'vector';
  IF extension_oid IS NULL THEN
    RAISE NOTICE 'vector extension is not installed; nothing to grant';
    RETURN;
  END IF;

  FOR function_signature IN
    SELECT format('%s(%s)', p.oid::regproc::text, pg_get_function_identity_arguments(p.oid))
    FROM pg_depend d
    JOIN pg_proc p ON p.oid = d.objid
    WHERE d.refclassid = 'pg_extension'::regclass
      AND d.refobjid = extension_oid
      AND d.classid = 'pg_proc'::regclass
      -- Aggregate transition functions are reached through the aggregate itself and cannot be granted
      -- individually in older versions; the aggregate's own entry covers them.
      AND p.prokind IN ('f', 'a', 'w')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO "builderhunt_app", "builderhunt_worker", "builderhunt_platform", "builderhunt_capability"',
      function_signature
    );
    granted_count := granted_count + 1;
  END LOOP;

  RAISE NOTICE 'granted EXECUTE on % vector extension functions', granted_count;
END
$$;
