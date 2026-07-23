-- RLS and runtime-role grants for organization_deletion_financial_records, added in 0039
-- (plans/stripe-billing-platform/tasks.md §9, "Integrate subscription-safe organization deletion").
-- Deliberately a separate migration from 0039's CREATE TABLE, matching this codebase's established
-- split (0027/0028, 0032/0033, 0035/0036, 0037/0038, ...).
--
-- No organization-scoped RLS filter here, unlike every other tenant table in this schema: by the
-- time a row exists, the organization it describes has already been (or is about to be) hard-deleted
-- — there is no live `app.organization_id` to scope by. Access is role-gated only.
--
-- Role split:
--   - builderhunt_app: NO access at all. This is platform compliance data about organizations that
--     no longer exist; the tenant/app role has no legitimate reason to ever read or write it.
--   - builderhunt_worker: INSERT only — written once, at the moment `organizations/deletion.ts`
--     finalizes a deletion (scheduled grace-period sweep or the owner-initiated immediate path),
--     before the `organizations` row (and its cascade) is removed. Never updated or read back by the
--     worker itself.
--   - builderhunt_platform: SELECT only — for compliance/support lookups (e.g. "did we retain a
--     record when organization X was deleted"); no platform mutation path exists.

ALTER TABLE organization_deletion_financial_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_deletion_financial_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY organization_deletion_financial_records_worker_insert ON organization_deletion_financial_records
  FOR INSERT TO builderhunt_worker
  WITH CHECK (true);

CREATE POLICY organization_deletion_financial_records_platform_select ON organization_deletion_financial_records
  FOR SELECT TO builderhunt_platform
  USING (true);
--> statement-breakpoint

REVOKE ALL ON TABLE organization_deletion_financial_records FROM PUBLIC;

GRANT INSERT ON TABLE organization_deletion_financial_records TO builderhunt_worker;
GRANT SELECT ON TABLE organization_deletion_financial_records TO builderhunt_platform;
