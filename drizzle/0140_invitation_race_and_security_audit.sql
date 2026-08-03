-- Custom SQL migration file, put your code below! --
--
-- Two changes, plus the one data step the first of them needs.
--
-- ## Why this SQL is hand-written when 0140_snapshot.json was generated
--
-- `drizzle-kit generate` produced a 439-line migration with 19 `CREATE TABLE`s, 18 of them for tables that already
-- exist. The cause: snapshots stopped tracking new tables at 0122, when this project switched to hand-written custom
-- migrations, so snapshot 0139 described 106 tables against a database holding 124. The generated *snapshot* is
-- correct — it derives from `schema.ts` and now knows all 125 — so it is kept, and this SQL carries only the real
-- delta. From 0140 onward `generate` diffs against a truthful snapshot again.

-- ── 1. Durable security audit ───────────────────────────────────────────────────────────────────
--
-- `emitSecurityAudit` always took its sink as a parameter; the only implementation was a `console.log`. Plan 32 hit
-- that while building denial clustering, confirmed no durable table existed, and routed around it with Redis
-- counters. This is the table it named.
--
-- No foreign keys on `organization_id` / `actor_user_id`, on purpose: an audit trail has to outlive its subjects, and
-- a cascade would delete the record of what an organization did at the moment the organization is deleted — exactly
-- when that record matters most.
CREATE TABLE IF NOT EXISTS "security_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"result" text NOT NULL,
	"request_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_audit_events_result_check" CHECK ("security_audit_events"."result" in ('allowed', 'denied', 'failed'))
);
--> statement-breakpoint
-- The three questions this table answers: what happened to this organization, what did this actor do, and who did X.
-- Each is a range scan over time, so each index leads with its key and orders by `created_at`.
CREATE INDEX IF NOT EXISTS "security_audit_events_org_idx" ON "security_audit_events" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_audit_events_actor_idx" ON "security_audit_events" USING btree ("actor_user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_audit_events_action_idx" ON "security_audit_events" USING btree ("action","created_at");
--> statement-breakpoint
ALTER TABLE "security_audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Append-only, and the grants say so: INSERT for the writer, SELECT for the operator, DELETE for retention, UPDATE
-- for nobody. An audit row that can be edited is not evidence.
--
-- The writer is `builderhunt_auth`, not `builderhunt_app`: the sink is wired into the organization-lifecycle
-- dependencies, which write through `authDb` (`DATABASE_AUTH_URL`). Granting `app` alone would make every insert fail
-- with 42501 — and the sink swallows insert failures by design, so the audit would have silently stayed console-only,
-- which is the exact problem this table exists to fix.
CREATE POLICY "security_audit_events_writer_insert" ON "security_audit_events"
  FOR INSERT TO "builderhunt_auth", "builderhunt_app", "builderhunt_worker"
  WITH CHECK (true);
--> statement-breakpoint
-- No SELECT policy for the writers. `emitSecurityAudit` never reads, and a trail the request path can read back is a
-- trail it can leak, so the absence is the design rather than an omission.
CREATE POLICY "security_audit_events_worker_delete" ON "security_audit_events"
  FOR DELETE TO "builderhunt_worker"
  USING (true);
--> statement-breakpoint
GRANT INSERT ON "security_audit_events" TO "builderhunt_auth";
--> statement-breakpoint
GRANT INSERT ON "security_audit_events" TO "builderhunt_app";
--> statement-breakpoint
GRANT INSERT, DELETE ON "security_audit_events" TO "builderhunt_worker";
--> statement-breakpoint
-- Conditional, following 0107's convention: these operator roles are not present in every environment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_platform_admin') THEN
    CREATE POLICY "security_audit_events_admin_select" ON "security_audit_events"
      FOR SELECT TO "builderhunt_platform_admin" USING (true);
    GRANT SELECT ON "security_audit_events" TO "builderhunt_platform_admin";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_platform') THEN
    CREATE POLICY "security_audit_events_platform_select" ON "security_audit_events"
      FOR SELECT TO "builderhunt_platform" USING (true);
    GRANT SELECT ON "security_audit_events" TO "builderhunt_platform";
  END IF;
END $$;
--> statement-breakpoint
-- ── 2. At most one pending invitation per (organization, email) ──────────────────────────────────
--
-- `inviteMember` read "is there a pending one?" and then inserted — correct in every sequential test, wrong the moment
-- two requests overlap: both read "none" before either commits. Measured 2026-08-02: six concurrent invitations to one
-- address produced four pending rows. A pending invitation holds a seat, so duplicates consume seats the organization
-- did not buy, and the invitee gets four links of which at most one still resolves.
--
-- The data step comes first because a unique index fails on any database that already holds duplicates. Cancelled
-- rather than deleted: `canceled` is a real state in this table's own check constraint, and the row still answers
-- "was this person invited twice?" afterwards.
UPDATE "organization_invitations" AS stale
SET "status" = 'canceled'
WHERE stale."status" = 'pending'
  AND stale."id" <> (
    SELECT keep."id"
    FROM "organization_invitations" AS keep
    WHERE keep."organization_id" = stale."organization_id"
      AND keep."email" = stale."email"
      AND keep."status" = 'pending'
    ORDER BY keep."created_at" DESC, keep."id" DESC
    LIMIT 1
  );
--> statement-breakpoint
-- Partial, not total: accepted/rejected/canceled rows are history and must be allowed to accumulate, or re-inviting
-- someone who declined would stop working. `resendInvitation` already cancels before it re-creates, so it never
-- collides with this.
CREATE UNIQUE INDEX IF NOT EXISTS "organization_invitations_one_pending_unique" ON "organization_invitations" USING btree ("organization_id","email") WHERE "organization_invitations"."status" = 'pending';
