-- Custom SQL migration file, put your code below! --
-- A database-backed register for the people-search connectors, so an operator can switch a source off
-- from the admin UI instead of shipping a deploy.
--
-- Until now the fifteen connectors were a hardcoded `if (want('github')) connectors.push(...)` list in
-- src/lib/search.ts. `sources` on the request could narrow that list, which means the *caller* chose
-- which sources ran — there was no operator-side switch at all. This table is that switch, and it is
-- read per search so flipping it takes effect on the next query.
--
-- Deliberately a separate table from `solution_sources` rather than one register with a `domain`
-- column. They answer different questions and carry different obligations: a solutions source
-- contributes facts about tools, and its risk is a wrong capability claim; a search source contributes
-- data about *people*, and its risk is processing someone's personal data without a basis. The columns
-- that matter differ (`stores_personal_data`, `retention_days` here; `allowed_fields` there), and
-- collapsing them would mean half the columns are NULL in every row.
--
-- Global-public: no `organization_id`. Whether a source may be contacted at all is a platform-level
-- decision, not a tenant preference. A tenant narrowing its own searches is a request parameter.

CREATE TABLE "search_sources" (
  "key" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "homepage_url" text NOT NULL,
  -- The kill switch. Read on every search, so switching a source off stops the next query rather than
  -- the next deploy.
  "enabled" boolean DEFAULT false NOT NULL,
  -- Whether code exists to query this source. NOT an operator toggle: "does an adapter exist" is a
  -- fact about the repository, so it changes in a migration alongside the connector that lands. It
  -- exists as a column so the constraint below can use it, and so the admin UI can distinguish
  -- "switched off" from "nothing to switch on" instead of showing a dead toggle.
  "connector_implemented" boolean DEFAULT false NOT NULL,
  -- Hosts the connector may contact, for the register to be auditable without reading the source.
  "allowed_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- Every people-search source processes personal data by definition, but an external-link-only entry
  -- stores none of it, and the constraint below holds it to that.
  "stores_personal_data" boolean DEFAULT true NOT NULL,
  "geography" text,
  "rate_limit_per_hour" integer,
  "retention_days" integer,
  "terms_reviewed_at" timestamp with time zone,
  "terms_reviewed_by" text REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "register_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "search_sources_kind_check"
    CHECK ("kind" IN ('official_api', 'feed', 'licensed_dataset', 'user_submission', 'public_scrape', 'external_link_only')),
  -- The same legal gate as `solution_sources_scrape_needs_review_check`: a scrape cannot be enabled
  -- until a human review is recorded. The admin toggle therefore physically cannot start a crawl
  -- nobody signed off, and no future code path can bypass it either.
  CONSTRAINT "search_sources_scrape_needs_review_check"
    CHECK ("kind" <> 'public_scrape' OR "enabled" = false OR "terms_reviewed_at" IS NOT NULL),
  -- External-link-only means exactly that: we link out and store nothing.
  CONSTRAINT "search_sources_link_only_stores_nothing_check"
    CHECK ("kind" <> 'external_link_only' OR "stores_personal_data" = false),
  -- An enabled source with no connector is a promise the product cannot keep: the UI would offer it,
  -- the search would report it healthy, and it would contribute nothing. Refuse the state rather than
  -- explain it later.
  CONSTRAINT "search_sources_enabled_needs_connector_check"
    CHECK ("enabled" = false OR "connector_implemented" = true),
  -- Retention has to be a positive number of days when we keep personal data at all. `NULL` here would
  -- read as "keep forever", which is not a retention policy.
  CONSTRAINT "search_sources_retention_check"
    CHECK ("stores_personal_data" = false OR ("retention_days" IS NOT NULL AND "retention_days" > 0))
);
CREATE INDEX "search_sources_enabled_idx" ON "search_sources" ("enabled");

-- The fifteen connectors that were already live in src/lib/search.ts, seeded `enabled = true`.
--
-- A note on why these are NOT seeded disabled the way `solution_sources` are: this register is being
-- placed under an existing, working search. Seeding everything off would silently return zero results
-- for every query until an operator went and switched fifteen rows on. The seeded state records what
-- was already running, and `register_notes` says so — it is a description of the status quo, not a
-- fresh legal blessing of it.
INSERT INTO "search_sources"
  ("key", "kind", "label", "homepage_url", "enabled", "connector_implemented", "allowed_hosts",
   "stores_personal_data", "retention_days", "geography", "register_notes")
VALUES
  ('github', 'official_api', 'GitHub', 'https://github.com', true, true,
   '["github.com","api.github.com"]'::jsonb, true, 180, 'global',
   'Documented REST API, public read scope. Mirrors the enrichment register entry (docs/operations/public-enrichment-source-register.md#github).'),
  ('hn', 'official_api', 'Hacker News', 'https://news.ycombinator.com', true, true,
   '["hn.algolia.com","news.ycombinator.com"]'::jsonb, true, 180, 'global',
   'Algolia HN Search API, published by YC for programmatic use.'),
  ('devto', 'official_api', 'DEV Community', 'https://dev.to', true, true,
   '["dev.to"]'::jsonb, true, 180, 'global', 'Public Forem API.'),
  ('reddit', 'official_api', 'Reddit', 'https://www.reddit.com', true, true,
   '["oauth.reddit.com","www.reddit.com"]'::jsonb, true, 180, 'global',
   'OAuth application API under Reddit developer terms.'),
  ('lobsters', 'official_api', 'Lobsters', 'https://lobste.rs', true, true,
   '["lobste.rs"]'::jsonb, true, 180, 'global', 'Public JSON endpoints.'),
  ('stackoverflow', 'official_api', 'Stack Overflow', 'https://stackoverflow.com', true, true,
   '["api.stackexchange.com","stackapps.com"]'::jsonb, true, 180, 'global',
   'Stack Exchange API v2.3, registered application.'),
  ('npm', 'official_api', 'npm registry', 'https://www.npmjs.com', true, true,
   '["registry.npmjs.org","www.npmjs.com"]'::jsonb, true, 180, 'global',
   'Registry API, the same endpoint every package manager uses.'),
  ('huggingface', 'official_api', 'Hugging Face', 'https://huggingface.co', true, true,
   '["huggingface.co"]'::jsonb, true, 180, 'global', 'Documented public HTTP API.'),
  ('gitlab', 'official_api', 'GitLab', 'https://gitlab.com', true, true,
   '["gitlab.com"]'::jsonb, true, 180, 'global', 'REST API v4, public read scope.'),
  ('codeberg', 'official_api', 'Codeberg', 'https://codeberg.org', true, true,
   '["codeberg.org"]'::jsonb, true, 180, 'global', 'Forgejo API, public read scope.'),
  ('hashnode', 'official_api', 'Hashnode', 'https://hashnode.com', true, true,
   '["api.hashnode.com","gql.hashnode.com","hashnode.com"]'::jsonb, true, 180, 'global',
   'Public GraphQL API.'),
  ('sourcehut', 'official_api', 'SourceHut', 'https://sr.ht', true, true,
   '["meta.sr.ht","sr.ht"]'::jsonb, true, 180, 'global', 'Public GraphQL API.'),
  ('producthunt', 'official_api', 'Product Hunt', 'https://www.producthunt.com', true, true,
   '["api.producthunt.com","www.producthunt.com"]'::jsonb, true, 180, 'global',
   'GraphQL API, registered application.'),
  ('bluesky', 'official_api', 'Bluesky', 'https://bsky.app', true, true,
   '["bsky.app","public.api.bsky.app"]'::jsonb, true, 180, 'global',
   'AT Protocol public XRPC endpoints.');

-- Devpost is the one people-search source that is a real crawl: it has no API and bot-challenges a
-- plain server-side fetch, so plan 19 built a headless-browser worker behind hard per-run caps. That
-- decision was made and shipped before this register existed; `terms_reviewed_at` records *that* it was
-- made and points at where, which is what lets the scrape-needs-review constraint pass. It is not a new
-- review, and the note says so rather than implying a legal conclusion this migration is not entitled
-- to reach.
INSERT INTO "search_sources"
  ("key", "kind", "label", "homepage_url", "enabled", "connector_implemented", "allowed_hosts",
   "stores_personal_data", "retention_days", "geography", "terms_reviewed_at", "register_notes")
VALUES
  ('devpost', 'public_scrape', 'Devpost', 'https://devpost.com', true, true,
   '["devpost.com","www.devpost.com"]'::jsonb, true, 180, 'global', '2025-01-01T00:00:00Z',
   'Headless-browser crawl (src/lib/devpost/worker.ts), politeness delay and per-run caps. terms_reviewed_at records the pre-existing plan-19 decision and its date, NOT a review performed by this migration. Re-review is tracked in plans/phase-5/01-production-readiness-audit.');

-- Registered, permanently unavailable, and visible in the admin UI as such.
--
-- These four are in `HARD_BLOCKED_CONNECTOR_IDS` (src/lib/enrichment/policies.ts) because their terms
-- prohibit automated collection and no permission is on file. Registering them is not a step towards
-- enabling them — it is so the admin UI can show *why* they are absent instead of leaving an operator
-- to wonder whether someone forgot. Three constraints each independently refuse the enabled state:
-- there is no connector, the kind stores nothing, and no terms review exists.
--
-- Turning any of these on is a decision with a named owner who has read the platform's terms and
-- recorded a lawful basis. The mechanism accepts that decision; it does not make it.
INSERT INTO "search_sources"
  ("key", "kind", "label", "homepage_url", "enabled", "connector_implemented", "allowed_hosts",
   "stores_personal_data", "geography", "register_notes")
VALUES
  ('linkedin', 'external_link_only', 'LinkedIn', 'https://www.linkedin.com', false, false,
   '[]'::jsonb, false, 'global',
   'https://www.linkedin.com/legal/crawling-terms prohibits automated collection; no permission on file. Profiles are personal data of people who are not our users, so an EU controller also needs a lawful basis and Art.14 notice, neither of which exists. Outbound links only.'),
  ('x', 'external_link_only', 'X', 'https://x.com', false, false,
   '[]'::jsonb, false, 'global',
   'https://x.com/en/tos requires prior written consent for automated access; none on file. Outbound links only.'),
  ('facebook', 'external_link_only', 'Facebook', 'https://www.facebook.com', false, false,
   '[]'::jsonb, false, 'global',
   'https://www.facebook.com/legal/automated_data_collection_terms — no permission on file. Outbound links only.'),
  ('instagram', 'external_link_only', 'Instagram', 'https://www.instagram.com', false, false,
   '[]'::jsonb, false, 'global',
   'https://www.facebook.com/legal/automated_data_collection_terms — no permission on file. Outbound links only.');

-- Jobindex publishes an RSS feed with query support (jobsoegning.rss?q=...), declaring ttl=1440. A
-- publisher offering RSS is offering it for machine consumption, so this is a `feed`, not a scrape, and
-- the 24h ttl is honoured as the refresh interval rather than ignored.
--
-- It goes in `solution_sources` and deliberately NOT in `search_sources` above. A job posting is an
-- employer describing a role it wants filled — demand-side data about a company, not a candidate
-- profile. Registering it as a people-search connector would imply a `searchJobindex` returning
-- builders, and there is no person in a job ad to return. Postings become `human_role` components,
-- which the catalog already has a kind for.
--
-- `allowed_fields` is enforced by the adapter runner (filterToAllowedFields in
-- src/lib/solutions/sources/runner.ts), so this list is the hard bound on what a posting can
-- contribute — not documentation of intent.
INSERT INTO "solution_sources"
  ("key", "kind", "label", "homepage_url", "enabled", "allowed_fields", "geography",
   "rate_limit_per_hour", "refresh_interval_hours", "retention_days", "register_notes")
VALUES
  ('jobindex_roles', 'feed', 'Jobindex open roles (DK)', 'https://www.jobindex.dk', false,
   '["roleTitle","companyName","area","summary","postingUrl","publishedAt"]'::jsonb, 'dk', 24, 24, 90,
   'Official RSS feed. Yields human_role components describing roles Danish employers are hiring for — demand-side market signal, not candidate data. Company names are corporate identifiers, not personal data. No capability claims: a job ad states what an employer wants, never what anyone can do.');

-- Grants. The app role reads the register on every search, so it needs SELECT and nothing else. The
-- worker reads it for the same reason and likewise never writes: a source able to enable itself would
-- make the kill switch decorative, which is the whole point of having one.
GRANT SELECT ON "search_sources" TO "builderhunt_app";
GRANT SELECT ON "search_sources" TO "builderhunt_worker";
-- SELECT alongside INSERT/UPDATE because the toggle route uses RETURNING, which requires it.
GRANT SELECT, INSERT, UPDATE ON "search_sources" TO "builderhunt_platform";
