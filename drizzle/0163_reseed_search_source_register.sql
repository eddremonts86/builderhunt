-- Re-seed the search source register, because production's copy is empty.
--
-- `0126_search_source_register.sql` creates `search_sources` and seeds nineteen rows in the same file,
-- thirteen of them enabled. Locally and in CI that is exactly what the table holds. Production holds
-- the table and **zero rows** — verified against the live database on 2026-08-09, which answered the
-- select without error and returned `[]`.
--
-- What that cost: `resolveContactableSources` refuses every source the register does not list, and
-- `partitionRequestedSources` swallows a query failure into that same empty answer. So production
-- search returned nothing, for every query and every source, and reported it as "Switched off in the
-- source register" — a message that reads like an operator's decision rather than missing data. It had
-- been that way since the register shipped on 2026-08-01.
--
-- Why a new migration rather than repairing 0126: drizzle-kit hashes migration contents, so editing an
-- applied file makes it re-run everywhere. The rule in CLAUDE.md is to add one instead.
--
-- Why the rows were missing is not settled. The table exists while its seed did not run, which points
-- at production's drizzle journal having been baselined — tables created from the schema and every
-- migration marked applied without executing. If that is what happened, other reference data seeded by
-- migration is missing too, and this file repairs one instance of a wider problem.
--
-- Idempotent by construction: `ON CONFLICT ("key") DO NOTHING` makes it a no-op wherever the register
-- is already populated, so local and CI are untouched. The two retirements from 0143 and 0144 are
-- replayed verbatim afterwards, because against an empty table their UPDATEs matched no row — without
-- them this would revive SourceHut and Hashnode as enabled, which their own notes forbid.

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
   'AT Protocol public XRPC endpoints.')
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint

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
   'Headless-browser crawl (src/lib/devpost/worker.ts), politeness delay and per-run caps. terms_reviewed_at records the pre-existing plan-19 decision and its date, NOT a review performed by this migration. Re-review is tracked in plans/phase-5/01-production-readiness-audit.')
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint

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
   'https://www.facebook.com/legal/automated_data_collection_terms — no permission on file. Outbound links only.')
ON CONFLICT ("key") DO NOTHING;

--> statement-breakpoint
UPDATE "search_sources"
SET "enabled" = false,
    "connector_implemented" = false,
    "register_notes" = 'Retired 2026-08-04. sr.ht''s robots.txt prose policy disallows "anything used to feed a '
      || 'machine learning model", which is what this product does — so no access token resolves it. The API also '
      || 'offers no user or repository search (meta.sr.ht has no users(search:) field; git.sr.ht reaches '
      || 'repositories only through a known username), so the connector had never returned a result. Reverse by '
      || 'setting connector_implemented = true once a connector exists that the policy permits.'
WHERE "key" = 'sourcehut';

--> statement-breakpoint
UPDATE "search_sources"
SET "enabled" = false,
    "connector_implemented" = false,
    "register_notes" = 'Retired 2026-08-04. Hashnode moved its public GraphQL API to a paid offering: '
      || 'gql.hashnode.com 301s to hashnode.com/announcements/graphql-api and api.hashnode.com now 404s (both '
      || 'verified live). The connector returned [] for every query regardless of HASHNODE_API_KEY, which was '
      || 'documented as optional — so nothing in its behaviour revealed that it had stopped working. Reverse by '
      || 'setting connector_implemented = true once a connector exists against a plan that has been paid for.'
WHERE "key" = 'hashnode';
