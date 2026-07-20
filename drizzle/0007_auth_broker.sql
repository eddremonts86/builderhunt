DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_auth') THEN
    CREATE ROLE builderhunt_auth LOGIN;
  END IF;
END
$$;
--> statement-breakpoint

ALTER ROLE builderhunt_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO builderhunt_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  auth_users,
  auth_sessions,
  auth_accounts,
  auth_verifications,
  organizations,
  organization_members,
  organization_invitations
TO builderhunt_auth;

-- Product SQL must use builderhunt_app. Remove the temporary bootstrap access
-- granted before the dedicated Better Auth adapter existed.
REVOKE ALL ON TABLE auth_users, auth_sessions, auth_accounts, auth_verifications FROM builderhunt_app;
