-- Custom SQL migration file, put your code below! --

-- Beta mode: one global, reversible switch that lets every authenticated organization use Pro Max
-- product capabilities during a public beta (plan 58).
--
-- ## A dedicated table, not a generic flag registry
--
-- The superseded draft proposed `system_flags (key text primary key, value jsonb)`. A JSONB bag means
-- every reader parses an untyped shape, the constraint that "enabled is a boolean" lives nowhere, and
-- the next flag someone adds inherits this table's grants — including the platform role's UPDATE. One
-- named table with typed columns is smaller and it cannot become a dumping ground.
--
-- ## Exactly one row, enforced by the database
--
-- `CHECK (id = 'global')` plus a primary key means the table cannot hold a second row. Without it,
-- "the flag" becomes "whichever row the query happened to return first", and a second row is a silent
-- outage rather than an error.
CREATE TABLE IF NOT EXISTS platform_beta_mode (
  id text PRIMARY KEY CHECK (id = 'global'),
  enabled boolean NOT NULL DEFAULT false,
  -- Counts writes, so a stale admin screen can be refused rather than allowed to overwrite a decision
  -- somebody else made while it was open. Distinct from a schema version: this changes on every save.
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Deliberately no foreign key to auth_users: operational history has to survive the deletion of the
  -- operator who made the change. A FK here would either block the account deletion or erase the
  -- record of who enabled beta mode.
  updated_by text
);
--> statement-breakpoint

-- Seeded disabled. Shipping the schema and the code with the switch off is what makes the rollout
-- observable: raw and effective entitlements can be compared in production before anything changes.
INSERT INTO platform_beta_mode (id, enabled)
VALUES ('global', false)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- ## No RLS, and the reason is structural
--
-- The table holds no tenant data — no organization_id, no owning subject — so there is no predicate an
-- RLS policy could express. Same reasoning as `access_requests` (0147), `profile_removal_requests`
-- (0064) and `status_checks` (0048): access is controlled entirely by GRANT.

-- The runtime roles read the flag on every authorization and every reservation, and they must never be
-- able to change it. SELECT only.
GRANT SELECT ON TABLE platform_beta_mode TO builderhunt_app;
--> statement-breakpoint
GRANT SELECT ON TABLE platform_beta_mode TO builderhunt_readonly;
--> statement-breakpoint
GRANT SELECT ON TABLE platform_beta_mode TO builderhunt_worker;
--> statement-breakpoint

-- The platform-admin role is the only writer. INSERT is granted alongside UPDATE so the seed above can
-- be re-established if the row is ever lost, without needing a superuser.
GRANT SELECT, INSERT, UPDATE ON TABLE platform_beta_mode TO builderhunt_platform;
--> statement-breakpoint

-- No role receives DELETE. Turning beta mode off is `enabled = false`, which keeps the revision, the
-- timestamp and the actor — deleting the row would discard the audit trail and make "disabled" and
-- "never configured" indistinguishable to every reader.
REVOKE DELETE ON TABLE platform_beta_mode FROM PUBLIC;
