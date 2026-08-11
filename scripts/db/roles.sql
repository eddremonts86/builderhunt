-- Cluster-role bootstrap for a RESTORE into a fresh Postgres cluster.
--
-- Why this file exists
-- ===================
-- `pg_dump` of a single database — which is what Coolify's scheduled backup of
-- `builderhunt-db` produces — does NOT include roles. Roles are cluster-level
-- objects, so they live in `pg_dumpall`, not `pg_dump`.
--
-- This project's entire multi-tenant security model is RLS policies bound to named
-- roles (`builderhunt_app`, `_auth`, `_worker`, `_platform`). Every one of those
-- `CREATE POLICY ... TO builderhunt_app` statements in the dump fails with
-- `role "builderhunt_app" does not exist` if the roles are not present *before*
-- `pg_restore` runs. The 2026-07-26 restore test hit exactly this: 192 policies
-- silently not created, while `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY`
-- restored fine — leaving RLS forced on 54 tables with zero policies.
--
-- Apply this file to the target cluster BEFORE `pg_restore`. `scripts/db/restore.ts`
-- does that automatically; see `docs/operations/database-restore.md` for the manual
-- procedure.
--
-- Deliberately password-free
-- ==========================
-- No role here gets a PASSWORD. Credentials are provisioned out of band from the
-- `DATABASE_*_URL` env vars by `pnpm deploy:db` step 5 (`scripts/deploy/orchestrate.mjs`),
-- exactly as on a normal deploy. That is why an off-site roles dump is taken with
-- `--no-role-passwords`: a backup target should never hold credential material, and the
-- deploy path already owns password provisioning.
--
-- Kept in sync with the migrations
-- ================================
-- These definitions mirror the `CREATE ROLE` / `ALTER ROLE` statements in
-- `drizzle/0002_database_roles.sql`, `0007_auth_broker.sql` and `0012_platform_role.sql`.
-- `test/security/restore-roles-bootstrap.test.ts` fails if a future migration adds a role
-- that is missing here, or gives a role attributes that differ from these.
--
-- Grants and policies are NOT recreated here on purpose — those are per-database objects
-- and they come back with the dump. Only the cluster-level role identities are missing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_owner') THEN
    CREATE ROLE builderhunt_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_app') THEN
    CREATE ROLE builderhunt_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_auth') THEN
    CREATE ROLE builderhunt_auth LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_worker') THEN
    CREATE ROLE builderhunt_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_platform') THEN
    CREATE ROLE builderhunt_platform LOGIN;
  END IF;
  -- The accountless candidate portal's own role (drizzle/0078_capability_role.sql).
  -- It carries 19 policies of its own, so omitting it here would lose exactly as much
  -- tenant isolation on restore as the missing roles this file was written for.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_capability') THEN
    CREATE ROLE builderhunt_capability LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_readonly') THEN
    CREATE ROLE builderhunt_readonly LOGIN;
  END IF;
END
$$;

-- Re-assert the attributes even when the role already existed: a role created by hand
-- during an incident is the most likely way a restored cluster ends up with a
-- SUPERUSER or BYPASSRLS app role, which would defeat every policy in the dump.
ALTER ROLE builderhunt_owner    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_app      LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_auth     LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_worker   LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_platform   LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_capability LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_readonly LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- ── Per-role timeouts (drizzle/0168_role_timeouts.sql) ───────────────────────────────────────────
--
-- Mirrored here for the same reason every other attribute in this file is: a restored cluster runs the
-- dump's policies, and `ALTER ROLE ... SET` is *role* state, not database state — `pg_dump` of a database
-- does not carry it. Without this, a restore comes back with correct RLS and no timeouts, and the first
-- load event after it exhausts the pool exactly the way plan 55 exists to prevent.
--
-- The tiers and the reasoning are documented in the migration. `builderhunt_readonly` is deliberately
-- absent: it is the restore and inspection identity, driven by a human at a psql prompt, and a timeout
-- there turns a legitimate long analytical query into a mystery cancellation.
--
-- Idempotent by nature: `ALTER ROLE ... SET` overwrites, so re-running this after a hand-edit during an
-- incident puts the budget back rather than compounding it.
ALTER ROLE builderhunt_app SET statement_timeout = '5s';
ALTER ROLE builderhunt_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE builderhunt_auth SET statement_timeout = '5s';
ALTER ROLE builderhunt_auth SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE builderhunt_capability SET statement_timeout = '5s';
ALTER ROLE builderhunt_capability SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE builderhunt_worker SET statement_timeout = '30s';
ALTER ROLE builderhunt_worker SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE builderhunt_platform SET statement_timeout = '15s';
ALTER ROLE builderhunt_platform SET idle_in_transaction_session_timeout = '10s';
