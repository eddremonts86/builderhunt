-- Custom SQL migration file, put your code below! --
--
-- Retires Hashnode (plans/phase-1/16-hashnode-integration). Same shape as `0143` for SourceHut, and the same
-- mechanism for the same reasons — see that migration's comment for why this UPDATEs the row rather than
-- deleting it, and why `connector_implemented = false` is what makes an accidental re-enable impossible.
--
-- The reason here is simpler than SourceHut's: **Hashnode moved its public GraphQL API behind a paid plan.**
-- Re-verified live on 2026-08-04, not recalled: `POST https://gql.hashnode.com` answers `301` to
-- `https://hashnode.com/announcements/graphql-api` ("GraphQL API is moving to a paid offering"), and the older
-- `api.hashnode.com` has degraded further still and now answers `404` — in July it at least redirected.
--
-- So the connector has returned `[]` for every query since the change, with or without `HASHNODE_API_KEY`, and
-- the key was documented as *optional* — meaning nothing about the source's behaviour told anyone it had
-- stopped working. That is the same failure mode the SourceHut retirement recorded: a source that degrades
-- silently is indistinguishable from a source nobody configured.
--
-- Reversal is one migration setting both booleans back, if the pricing changes or a paid plan is bought. The
-- decision to pay was offered and declined (2026-08-04).
UPDATE "search_sources"
SET "enabled" = false,
    "connector_implemented" = false,
    "register_notes" = 'Retired 2026-08-04. Hashnode moved its public GraphQL API to a paid offering: '
      || 'gql.hashnode.com 301s to hashnode.com/announcements/graphql-api and api.hashnode.com now 404s (both '
      || 'verified live). The connector returned [] for every query regardless of HASHNODE_API_KEY, which was '
      || 'documented as optional — so nothing in its behaviour revealed that it had stopped working. Reverse by '
      || 'setting connector_implemented = true once a connector exists against a plan that has been paid for.'
WHERE "key" = 'hashnode';
