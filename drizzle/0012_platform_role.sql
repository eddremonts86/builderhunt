DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_platform') THEN
    CREATE ROLE builderhunt_platform LOGIN;
  END IF;
END
$$;
--> statement-breakpoint

ALTER ROLE builderhunt_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO builderhunt_platform;

-- Platform administration is deliberately limited to public editorial data,
-- account directory fields, and the legacy billing workflow. It receives no
-- grants on tenant product tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE incidents, changelog, roadmap_items TO builderhunt_platform;
GRANT SELECT ON TABLE auth_users TO builderhunt_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE plans, plan_changes, plan_requests TO builderhunt_platform;
