-- Cluster roles are created without credentials. Deployment automation must
-- provision/rotate LOGIN passwords out of band and must never expose the owner
-- identity to the web service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_owner') THEN
    CREATE ROLE builderhunt_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_app') THEN
    CREATE ROLE builderhunt_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_worker') THEN
    CREATE ROLE builderhunt_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_readonly') THEN
    CREATE ROLE builderhunt_readonly LOGIN;
  END IF;
END
$$;
--> statement-breakpoint

ALTER ROLE builderhunt_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE builderhunt_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO builderhunt_app, builderhunt_worker, builderhunt_readonly;

-- Better Auth requires these account-subject tables. Product/tenant table
-- grants are intentionally deferred to the RLS migration so a newly created
-- application credential is default-deny for private product data.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  auth_users,
  auth_sessions,
  auth_accounts,
  auth_verifications
TO builderhunt_app;

GRANT SELECT ON TABLE incidents, changelog, roadmap_items TO builderhunt_app, builderhunt_readonly;
