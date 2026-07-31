-- Idempotent backfill for `feed_capabilities_public_select` / `saved_queries_public_select`.
--
-- `0107_organization_activity.sql` defines these two policies, and a clean `drizzle-kit migrate`
-- replay from empty (fresh CI/test databases) creates them there with no gap. But this repo's
-- persistent local dev database has its `drizzle.__drizzle_migrations` tracking stuck at id=106
-- (migrations 107+ were front-run by hand at some point, not through `drizzle-kit migrate`), and
-- these two policies were appended to 0107 in a later commit, after that manual apply — so they
-- were never actually created here. Found 2026-07-31 while live-verifying the RSS feed-capability
-- fix: minting a capability worked, but the public `/api/feeds/$capabilityId` route 404'd on every
-- request because the anonymous SELECT it depends on had no policy to permit it. Same root cause
-- almost certainly explains why anonymous saved-query reads have never worked either.
--
-- DROP IF EXISTS + CREATE (rather than a bare CREATE) makes this converge correctly regardless of
-- which state a given database is in: a no-op drop + fresh create where the policy is genuinely
-- missing (this dev DB), and a harmless drop + identical recreate where 0107 already created it
-- (any cleanly-migrated database, including a fresh test DB that replays 0000-0110 in order).
DROP POLICY IF EXISTS "feed_capabilities_public_select" ON "feed_capabilities";--> statement-breakpoint
CREATE POLICY "feed_capabilities_public_select" ON "feed_capabilities"
  FOR SELECT TO "builderhunt_app"
  USING (id IS NOT NULL);--> statement-breakpoint
DROP POLICY IF EXISTS "saved_queries_public_select" ON "saved_queries";--> statement-breakpoint
CREATE POLICY "saved_queries_public_select" ON "saved_queries"
  FOR SELECT TO "builderhunt_app"
  USING (id IS NOT NULL);
