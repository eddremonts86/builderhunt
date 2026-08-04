# Public Profile Enrichment — Source Approval Register

> Companion to [`src/lib/enrichment/policies.ts`](../../src/lib/enrichment/policies.ts)
> (the compile-time enforcement point) and
> [`plans/phase-1/42-stealth-scraping/spec.md`](../../plans/phase-1/42-stealth-scraping/spec.md) §4.
> Every connector registered in `policies.ts` must have exactly one entry below.
> An entry with status `blocked` has no approval date and no lawful-basis reference.

## github

- **Acquisition mode**: `official_api` (GitHub REST API)
- **Status**: `enabled`
- **Owner**: Platform team
- **Permission reference**: GitHub REST API terms of service — public read-only endpoints,
  existing `GITHUB_TOKEN`. No scraping of `github.com` HTML pages.
- **Lawful basis**: legitimate interest (recruiter reviewing a candidate's already-public,
  self-published developer profile the builder chose to expose via a public API).
- **Approved fields**: profileUrl, username, displayName, headline (bio), organization,
  location, topics (public repo topics).
- **Allowed hosts**: `github.com`, `api.github.com`
- **Robots directive required**: no (official API, not HTML crawling)
- **Rate limit**: 20 requests/minute (well under GitHub's authenticated 5000/hour budget)
- **Retention**: raw candidate 30 days, accepted evidence 180 days
- **Review date**: 2026-07-20
- **Expiry**: 2027-07-20 (must be re-reviewed before this date; policies.ts fails closed
  automatically once expired)
- **Kill-switch owner**: Platform team — `ENRICHMENT_ALLOWED_CONNECTORS` env var

## user-submitted

- **Acquisition mode**: `user_submitted`
- **Status**: `enabled`
- **Owner**: Platform team
- **Permission reference**: the organization member or the verified profile owner submits
  the URL themselves; no automated fetch occurs for this connector.
- **Lawful basis**: consent (submitter-provided) / legitimate interest for org-submitted URLs.
- **Approved fields**: profileUrl only (stored as attributed evidence; no scraping).
- **Allowed hosts**: none — this connector never makes an outbound request.
- **Robots directive required**: n/a
- **Rate limit**: n/a
- **Retention**: raw candidate 30 days, accepted evidence 180 days
- **Review date**: 2026-07-20
- **Expiry**: 2027-07-20
- **Kill-switch owner**: Platform team

## linkedin

- **Acquisition mode**: `official_api` (not integrated)
- **Status**: `blocked`
- **Permission reference**: <https://www.linkedin.com/legal/crawling-terms> — prohibits
  automated crawling without express permission. No permission on file.
- **Lawful basis**: none — blocked.
- **Approved fields**: none. A LinkedIn URL may still be stored as a `user-submitted` link;
  it is never fetched.
- **Review date**: 2026-07-20 (re-review only if legal/product secures an API contract or
  written crawl permission)

## x

- **Acquisition mode**: `official_api` (not integrated)
- **Status**: `blocked`
- **Permission reference**: <https://x.com/en/tos> — prohibits scraping without prior
  written consent. No permission on file.
- **Lawful basis**: none — blocked.
- **Approved fields**: none.
- **Review date**: 2026-07-20

## facebook / instagram

- **Acquisition mode**: `official_api` (not integrated)
- **Status**: `blocked`
- **Permission reference**: <https://www.facebook.com/legal/automated_data_collection_terms>
  — requires express written permission. No permission on file.
- **Lawful basis**: none — blocked.
- **Approved fields**: none.
- **Review date**: 2026-07-20

## sourcehut (git.sr.ht / meta.sr.ht)

- **Acquisition mode**: `official_api` (retired 2026-08-04 — `drizzle/0143_retire_sourcehut_source.sql`)
- **Status**: `retired`. `search_sources` now holds `enabled = false, connector_implemented = false`, and the
  connector is deleted. The table's `CHECK ("enabled" = false OR "connector_implemented" = true)` means the
  source cannot be switched back on until a connector exists again, and `setSearchSourceEnabled` answers
  `no_connector` rather than a constraint error if anyone tries. The row is kept rather than deleted so this
  register still has something to point at; reversing it is one migration flipping both booleans.
- **Permission reference**: <https://git.sr.ht/robots.txt> (identical at meta.sr.ht), read
  2026-08-04. The file opens with a prose policy, not just directives:

  > Allowed: search engine indexers, archival services. **Disallowed: marketing or SEO
  > crawlers; anything used to feed a machine learning model**; bots which are too aggressive.

- **Lawful basis**: none. BuilderHunt indexes profiles into `builder_embeddings` (pgvector) and
  feeds AI ranking and explanation — it *is* the "used to feed a machine learning model" case the
  policy names. That excludes the use regardless of authentication, so a `SOURCEHUT_TOKEN` would not
  change the answer.
- **Approved fields**: none.
- **Also checked, 2026-08-04**: the unauthenticated surface was probed directly rather than assumed.
  `https://git.sr.ht/~user` answers 200 with a bare list of repository names, and is not in the
  machine-readable `Disallow` list. Everything that carries actual signal **is**: `/*/*/log/*`
  (including the per-repo `log/rss.xml` feed that returns 200), plus `blame`, `commit`, `tree`,
  `item`, `*/raw`, and any URL with a query string. So the only crawlable surface is a list of
  repository names with no activity, no dates and no profile fields — and the purpose policy excludes
  even that.
- **Review date**: 2026-08-04

## hashnode

- **Acquisition mode**: `official_api` (retired 2026-08-04 — `drizzle/0144_retire_hashnode_source.sql`)
- **Status**: `retired`. `search_sources` holds `enabled = false, connector_implemented = false` and the
  connector is deleted, same mechanism as `sourcehut` above.
- **Permission reference**: <https://hashnode.com/announcements/graphql-api> — "GraphQL API is moving to a paid
  offering."
- **Lawful basis**: none needed; nothing is fetched. Re-verified live 2026-08-04:
  `POST https://gql.hashnode.com` answers `301` to that announcement, and the older `api.hashnode.com` answers
  `404` (in July it still redirected).
- **Approved fields**: none.
- **Why it went unnoticed**: `HASHNODE_API_KEY` was documented as *optional*, so a source returning `[]` with no
  key looked identical to a source returning `[]` because the API had closed. Worth remembering when adding any
  future source whose key is optional.
- **Review date**: 2026-08-04

## Other existing BuilderHunt sources (reddit, hn, devto, npm, huggingface, gitlab,
## codeberg, lobsters, stackoverflow)

Not yet registered in `policies.ts` — per spec §4 "missing policy means disabled." Each
needs its own exact-profile adapter review (does the source's existing federated-search
endpoint support fetching one known profile by ID, without broad search?) before it can be
added with `status: 'approval_required'` or `'enabled'`. Tracked as future work in
`plans/phase-1/42-stealth-scraping/task.md` ("Additional official API adapters after individual
source-policy review").
