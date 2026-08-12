-- Custom SQL migration file, put your code below! --

-- Platform-admin console preferences, in their own table (plan 57, Admin track — "Persist isolated
-- platform-admin preferences").
--
-- ## Why a separate table and not a column on `dashboard_preferences`
--
-- The task's Verify line is "platform and tenant preferences cannot overwrite/read each other", and a shared
-- table cannot give that. `dashboard_preferences` is keyed `(organization_id, user_id)` and carries RLS scoping
-- every row to `app.organization_id` — which is exactly right for a tenant preference and exactly wrong for a
-- platform one. A platform admin has no organization in the context of the admin console; they are one person
-- with one console, and the same human is also a member of organizations. Storing both in one table would mean
-- either a nullable `organization_id` that the RLS predicate silently drops (so the preference would never load),
-- or a sentinel organization row that any tenant policy bug would expose.
--
-- Two tables, two roles, two predicates. A tenant read cannot reach this table at all: `builderhunt_app` is not
-- granted on it.
--
-- ## Why the platform role owns it
--
-- `builderhunt_platform` is the role the admin console already holds, and it is the role that fails closed for a
-- non-admin — the API re-checks the principal on every call, and the grant means a compromised app-role query
-- cannot read one platform admin's console layout, let alone write it.
--
-- ## Why no RLS
--
-- There is no tenant column and therefore no predicate a policy could express — the same rationale as
-- `status_checks`, `access_requests`, `platform_beta_mode` and `service_metric_buckets`. Access is GRANT-only,
-- and the row is keyed on the user so the route's `WHERE user_id = $me` is the whole scope. A policy of
-- `user_id = current_setting(...)` would be a second, weaker copy of a check the route already makes with the
-- authenticated principal rather than with a session variable.

CREATE TABLE IF NOT EXISTS "platform_admin_preferences" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
  -- Where the console opens. Validated against the section/range/variant allowlists in the application, not
  -- here: the vocabularies live in `admin-metrics/contracts.ts` and a CHECK constraint would be a second copy
  -- that drifts. What the constraint below *does* enforce is that they are short — a column holding an
  -- arbitrary-length string is a column somebody eventually puts a URL in.
  "landing_section" text NOT NULL DEFAULT 'overview',
  "landing_range" text NOT NULL DEFAULT '24h',
  "landing_variant" text NOT NULL DEFAULT 'summary',
  -- Widget ids this admin chose to hide, ids only and never component references. The application refuses to
  -- hide a required one (`REQUIRED_ADMIN_WIDGETS`); this column is a preference, not a permission.
  "hidden_widget_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Bumped when a stored shape stops being readable by the current build. A row from a future version is
  -- ignored rather than migrated in place — see the repository for why reading forward is refused.
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "platform_admin_preferences_landing_len_check" CHECK (
    length("landing_section") <= 32 AND length("landing_range") <= 8 AND length("landing_variant") <= 32
  ),
  CONSTRAINT "platform_admin_preferences_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- SELECT, INSERT and UPDATE — the write is an upsert, and `RETURNING` needs SELECT even when the write itself
-- would succeed without it.
--
-- **No DELETE**, for the same reason `dashboard_preferences` has none: nothing in the product deletes a
-- preference row, and "reset my layout" is an update back to the defaults. Granting a privilege because it might
-- one day be wanted is how a role ends up able to delete rows no code path needs.
GRANT SELECT, INSERT, UPDATE ON "platform_admin_preferences" TO "builderhunt_platform";
--> statement-breakpoint

-- Read-only reporting keeps its usual visibility. `builderhunt_app` is deliberately absent: a tenant-scoped
-- query has no business reading a platform admin's console layout, and the absence of the grant is what makes
-- "cannot read each other" a property of the database rather than of a code review.
GRANT SELECT ON "platform_admin_preferences" TO "builderhunt_readonly";
