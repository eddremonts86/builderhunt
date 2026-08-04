-- Custom SQL migration file, put your code below! --
--
-- Narrows two `*_public_select` policies that were unconditionally true, which quietly defeated tenant
-- isolation on the tables they cover.
--
-- ## What was wrong
--
-- `0110_public_select_policies_backfill.sql` (and `0107` before it) created:
--
--   CREATE POLICY "saved_queries_public_select"     ON "saved_queries"     FOR SELECT TO "builderhunt_app" USING (id IS NOT NULL);
--   CREATE POLICY "feed_capabilities_public_select" ON "feed_capabilities" FOR SELECT TO "builderhunt_app" USING (id IS NOT NULL);
--
-- `id IS NOT NULL` is true for every row. Both are PERMISSIVE and both target `builderhunt_app`, and
-- **Postgres ORs permissive policies together** — so each one made its table's tenant policy irrelevant.
-- Measured, not deduced: connected as `builderhunt_app` with `app.organization_id` set to organization A and
-- got rows from BOTH organizations; set it to B and A's row was still returned.
--
-- It was not exploitable through the product, because every repository read also filters `organization_id` in
-- SQL (`findSavedQueryById`, `listSavedQueries`, and the feed's own `findSavedQueryForCapability` all carry it
-- in the WHERE). So what was lost is defence in depth, not the front door — but the security policy explicitly
-- permits relying on RLS for tenant scoping, so the next query written that way would have read across tenants
-- with nothing to stop it.
--
-- Nothing caught it: `verify-rls-local.mjs` touched `saved_queries` once, as `builderhunt_platform`, and never
-- ran a cross-tenant A/B as `builderhunt_app`. The api-isolation suite passes because it exercises the query
-- layer, which does filter. Coverage for exactly this is added in the same change.
--
-- ## Why the policies exist at all, and what they actually need
--
-- The public RSS feed (`/api/feeds/$searchId`) is read by anonymous subscribers, so there is no
-- `app.organization_id` to scope by — the request carries a capability token instead. `0110`'s diagnosis was
-- right; only its predicate was too wide. What the route needs is narrow:
--
--   * `feed_capabilities`: look up one capability row to verify the token. It never needs a revoked or expired
--     one — the route answers the same 404 for "unknown id", "wrong token", "revoked" and "expired" (its own
--     comment says so), so hiding dead capabilities at the row level is behaviour-preserving.
--   * `saved_queries`: read the query a *live* capability points at. The route already knows the organization
--     id (it comes off the capability row) and filters on it, so the policy only has to stop being an obstacle
--     for queries that genuinely have a public feed.
--
-- Revocation therefore becomes effective at the row level too, which is stronger than before: a revoked
-- capability stops exposing its saved query even to a reader who guessed the id.
-- ## Both conditions, not just liveness — the first attempt at this migration got it wrong
--
-- Narrowing to "has a live capability" alone does NOT restore isolation, and the new A/B coverage caught it
-- immediately: with a live feed on each tenant's query, every `builderhunt_app` reader could see both rows
-- again, tenant context or not. Defensible for the feed's own content, which is public by design — but a
-- reader who *has* a tenant context should never gain rows from another tenant through a policy meant for
-- anonymous access.
--
-- So each policy requires **both**: no tenant context at all (which is exactly the anonymous subscriber's
-- situation — the feed route uses `publicDb` and never calls `set_config('app.organization_id')`) **and** a
-- live capability. Authenticated readers are unaffected: they keep `*_app_select`, which is scoped by
-- `organization_id`, and this policy simply never fires for them.
DROP POLICY IF EXISTS "feed_capabilities_public_select" ON "feed_capabilities";--> statement-breakpoint
CREATE POLICY "feed_capabilities_public_select" ON "feed_capabilities"
  FOR SELECT TO "builderhunt_app"
  USING (
    NULLIF(current_setting('app.organization_id', true), '') IS NULL
    AND "revoked_at" IS NULL
    AND ("expires_at" IS NULL OR "expires_at" > now())
  );--> statement-breakpoint
DROP POLICY IF EXISTS "saved_queries_public_select" ON "saved_queries";--> statement-breakpoint
-- The subquery reads `feed_capabilities`, which is itself RLS-protected. That is intentional and it composes:
-- the subquery runs under the querying role's own policies, so in the anonymous case it sees only live
-- capabilities here too, and a dead capability cannot re-open a saved query.
CREATE POLICY "saved_queries_public_select" ON "saved_queries"
  FOR SELECT TO "builderhunt_app"
  USING (
    NULLIF(current_setting('app.organization_id', true), '') IS NULL
    AND EXISTS (
      SELECT 1 FROM "feed_capabilities" fc
      WHERE fc."query_id" = "saved_queries"."id"
        AND fc."revoked_at" IS NULL
        AND (fc."expires_at" IS NULL OR fc."expires_at" > now())
    )
  );
