-- Custom SQL migration file, put your code below! --
-- The two things that have to exist before identities can ever be unified into people.
--
-- Measured before writing this: 175 rows in `builder_identities`, 0 rows in `canonical_humans`, 0 rows in
-- `human_source_links`, 0 entries in the review queue. The Phase 3 unification mechanism has never
-- produced a single link, and this migration removes the two reasons why.
--
-- ## 1. `kind` — 52 of those 175 identities are not people
--
-- `RawBuilder` has carried `kind: 'person' | 'repo'` since the first connector, and every write path drops
-- it: `builder_identities` had no column to put it in. The GitHub connector searches both users *and*
-- repositories, so `builder_identities` holds 41 GitHub rows and 11 GitLab rows whose "username" is
-- actually `owner/repo`, mixed in with real people and indistinguishable from them.
--
-- That breaks the product before it breaks identity resolution: a recruiter searching for people gets
-- repositories back, roughly a third of the time. And it makes unification actively dangerous — merging two
-- repositories into a "canonical human", or merging a repository into a person, is not a subtle error.
--
-- Backfilled by the one signal that is reliable rather than by guessing: on GitHub and GitLab a slash in
-- the identifier means `owner/repo`, because neither platform permits a slash in a username. Sources with
-- no repository concept keep the default.
--
-- ## 2. `identity_declared_links` — the signals every connector throws away
--
-- The APIs already hand us self-declared cross-links and nothing keeps them. Verified live against each
-- endpoint on 2026-08-01:
--
--   github        `blog`, `twitter_username`
--   dev.to        `website_url`, `twitter_username`, `github_username`
--   lobste.rs     `github_username`, `mastodon_username`
--   codeberg      `website`
--   stackoverflow `/users/{id}/associated` — a first-party identity graph across the whole SE network
--   bluesky       a handle that *is* a domain, proven by a `_atproto` DNS TXT record
--
--   gitlab, huggingface  expose no website or social field on their public user object
--   sourcehut, producthunt  require a bearer token
--   reddit        refused the request
--   hn            only free prose in `about`
--
-- A declared link on its own proves nothing — anyone can put any URL in a GitHub profile. What makes it
-- *deterministic* is reciprocity: if the site also links back to that exact account, the site's owner has
-- asserted the account is theirs, and the two statements together prove one controller. That is why
-- `verification_state` exists and why nothing here auto-links until it reaches `reciprocal`.
--
-- This table only records what was declared and what verification found. The decision stays in
-- `decideLink` (src/shared/lib/human-identity/link-policy.ts), which already refuses to auto-link anything
-- probabilistic — that gate is untouched.

ALTER TABLE "builder_identities"
  ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;

ALTER TABLE "builder_identities"
  ADD CONSTRAINT "builder_identities_kind_check"
  CHECK ("kind" IN ('person', 'repo', 'organization'));

-- On GitHub and GitLab a slash means `owner/repo`; neither allows a slash in a username, so this is a
-- reliable classification rather than a heuristic.
UPDATE "builder_identities"
SET "kind" = 'repo'
WHERE "source" IN ('github', 'gitlab') AND "username" LIKE '%/%';

-- Every read that means "a person" filters on this, so it is worth an index rather than a sequential scan.
CREATE INDEX "builder_identities_kind_idx" ON "builder_identities" ("kind");

CREATE TABLE "identity_declared_links" (
  "id" text PRIMARY KEY NOT NULL,
  "builder_identity_id" text NOT NULL REFERENCES "builder_identities"("id") ON DELETE CASCADE,
  "link_kind" text NOT NULL,
  -- Exactly what the source published, so a reviewer can see the declaration rather than our reading of it.
  "raw_value" text NOT NULL,
  -- The comparable form: a bare lowercase host for a website, a bare lowercase handle for an account. Two
  -- accounts declaring `https://Example.com/` and `example.com` are declaring the same thing, and a
  -- resolver that could not see that would find no reciprocity at all.
  "normalized_value" text NOT NULL,
  "verification_state" text DEFAULT 'declared' NOT NULL,
  -- When reciprocity was last confirmed, and what confirmed it. Null while merely declared.
  "verified_at" timestamp with time zone,
  "verification_detail" text,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "identity_declared_links_kind_check"
    CHECK ("link_kind" IN ('website', 'github', 'gitlab', 'twitter', 'mastodon', 'bluesky_handle', 'bluesky_did', 'stackexchange_account')),
  CONSTRAINT "identity_declared_links_state_check"
    -- `declared`      the source published it; proves only that this account claims it.
    -- `reciprocal`    the target links back to this exact account. Proves one controller.
    -- `dns_verified`  the target is a domain whose control is proven by DNS (an ATProto `_atproto` record).
    -- `unreachable`   the target could not be fetched. Not evidence of anything, and deliberately distinct
    --                 from `contradicted` — "we could not check" must never read as "we checked and it failed".
    -- `contradicted`  the target was fetched and does not link back.
    CHECK ("verification_state" IN ('declared', 'reciprocal', 'dns_verified', 'unreachable', 'contradicted')),
  -- A verified state must say when it was verified: an unstamped `reciprocal` cannot be aged out, and a
  -- reciprocity that was true two years ago is not evidence today.
  CONSTRAINT "identity_declared_links_verified_stamp_check"
    CHECK ("verification_state" NOT IN ('reciprocal', 'dns_verified') OR "verified_at" IS NOT NULL)
);

-- One row per declaration. A source re-serving the same link moves `last_seen_at` rather than appending.
CREATE UNIQUE INDEX "identity_declared_links_unique"
  ON "identity_declared_links" ("builder_identity_id", "link_kind", "normalized_value");
-- The resolver's core query: "which other identities declared this same value?" That join is where
-- reciprocity is found, so it runs on an index.
CREATE INDEX "identity_declared_links_normalized_idx"
  ON "identity_declared_links" ("link_kind", "normalized_value");
-- Finds the work: declarations not yet checked, oldest first.
CREATE INDEX "identity_declared_links_state_idx"
  ON "identity_declared_links" ("verification_state", "last_seen_at");

-- Grants. The request path writes declarations, because they arrive with a search observation — the same
-- reasoning that gives the app role INSERT on `builder_identities` and `builder_source_snapshots`.
-- Verification is a worker's job, and it needs UPDATE to record what it found.
GRANT SELECT, INSERT, UPDATE ON "identity_declared_links" TO "builderhunt_app";
GRANT SELECT, INSERT, UPDATE ON "identity_declared_links" TO "builderhunt_worker";
-- DELETE is platform-only: removing a declaration is a retention action or a subject's removal request.
GRANT SELECT, DELETE ON "identity_declared_links" TO "builderhunt_platform";
