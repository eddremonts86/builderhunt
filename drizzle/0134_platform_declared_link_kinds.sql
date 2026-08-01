-- Custom SQL migration file, put your code below! --
-- Lets a declaration point at another platform account directly, not only at a domain.
--
-- Found by testing a real pair. GitHub's `benhalpern` publishes `blog: https://dev.to/ben`, and dev.to's
-- `ben` publishes `github_username: benhalpern`. Each account points at the other — which is reciprocity in
-- its purest form, needs no domain, and needs no HTTP request to establish.
--
-- The previous design threw it away. `normalizeWebsite` rejects platform hosts, and rightly so for a
-- *website* declaration: treating `twitter.com/someone` as a site the account controls would make everyone
-- who links to a platform share a controller with everyone else who does. But rejecting the value entirely
-- discarded the strongest and cheapest signal available, because a platform URL is not a weak website claim —
-- it is a precise statement about a specific account.
--
-- So a declared URL that resolves to a known platform profile now becomes a declaration *of that platform's
-- kind*, carrying the handle. `github`, `gitlab`, `twitter` and `mastodon` already existed for exactly this;
-- the kinds added here are the platforms this product actually searches and could therefore resolve.
--
-- Nothing about the decision changes. A single direction is still a claim, still `declared`, and still routed
-- to review by `decideLink`. Two opposing directions is what makes it deterministic, and that is now findable
-- with a SQL join rather than a fetch.

ALTER TABLE "identity_declared_links"
  DROP CONSTRAINT "identity_declared_links_kind_check";

ALTER TABLE "identity_declared_links"
  ADD CONSTRAINT "identity_declared_links_kind_check"
  CHECK ("link_kind" IN (
    'website',
    -- Platform accounts. The value is the handle on that platform, so a declaration can be joined straight
    -- to a `builder_identities` row by (source, username) with no network call at all.
    'github', 'gitlab', 'codeberg', 'devto', 'lobsters', 'hashnode', 'stackoverflow',
    'twitter', 'mastodon',
    'bluesky_handle', 'bluesky_did',
    'stackexchange_account'
  ));
