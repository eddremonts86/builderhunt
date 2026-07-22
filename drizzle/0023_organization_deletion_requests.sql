CREATE TABLE "organization_deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"grace_period_ends_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_deletion_requests_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "organization_deletion_requests_status_check" CHECK ("organization_deletion_requests"."status" in ('pending', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX "organization_deletion_requests_grace_period_idx" ON "organization_deletion_requests" USING btree ("grace_period_ends_at");
--> statement-breakpoint

-- Same domain as organizations/organization_members/organization_invitations
-- (drizzle/0007_auth_broker.sql): owned entirely by the auth-broker
-- connection organization-lifecycle.ts already uses for those tables, never
-- by builderhunt_app/builderhunt_worker.
ALTER TABLE organization_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_deletion_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_deletion_requests_auth_broker_all ON organization_deletion_requests
  FOR ALL TO builderhunt_auth USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE organization_deletion_requests FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE organization_deletion_requests TO builderhunt_auth;