# Source register — operating the kill switches

Every external source BuilderHunt may contact has a row in one of two registers, and a switch in
**Admin → Sources**. Nothing contacts a source whose row is `enabled = false`.

Both registers are read on every run — a search reads `search_sources`, an ingestion adapter reads
`solution_sources` — so switching a source off takes effect on the next request. There is no deploy, no
cache to clear, and no job to drain.

## The two registers

| | `search_sources` | `solution_sources` |
|---|---|---|
| What the source contributes | data about **people** (builders) | facts about **tools**, models, services, open roles |
| The risk it carries | processing personal data with no lawful basis | a wrong capability claim reaching the composer |
| Enforced scope column | `allowed_hosts` | `allowed_fields` |
| Read by | `src/lib/search.ts` | `runSolutionSourceAdapter` |

They are separate tables rather than one with a `domain` column because the columns that matter differ.
`stores_personal_data` and `retention_days` are meaningless for a model catalog; `allowed_fields` is
meaningless for a connector whose output shape is fixed in code. Merging them would leave half of every
row NULL.

## Source kinds

| Kind | Meaning |
|---|---|
| `official_api` | A documented endpoint the publisher offers for programmatic use. Terms are accepted by holding a key. |
| `feed` | RSS/Atom or a published directory. A publisher offering a feed is offering it for machine consumption. |
| `licensed_dataset` | Data obtained under a written licence. |
| `user_submission` | Supplied by a member or authored in-house. No fetch happens. |
| `public_scrape` | A compliant crawl. **Cannot be enabled without a recorded terms review.** |
| `external_link_only` | We link out and store nothing. The fallback for sources whose terms prohibit ingestion. |

## What the database refuses

These are CHECK constraints, not conventions, so no future code path — or direct `UPDATE` — can bypass
them.

| Constraint | Refuses |
|---|---|
| `*_scrape_needs_review_check` | enabling a `public_scrape` source with `terms_reviewed_at IS NULL` |
| `*_link_only_stores_nothing_check` | an `external_link_only` source that stores anything |
| `search_sources_enabled_needs_connector_check` | enabling a source no code queries |
| `search_sources_retention_check` | keeping personal data with no retention period (NULL reads as "forever") |
| `solution_component_versions_no_overlap` | two open validity windows for one component |

## Enabling a source

1. Open **Admin → Sources**. Platform-admin only — enabling a source decides this product will contact a
   third party, which is not a tenant-scoped choice.
2. If the row shows **Needs review**, click **Record review** first. State what you read and what it
   permits: the terms or robots policy, the lawful basis, and any rate limit the source imposes. Your
   user id is stored against it.
3. Click **Enable**.

Recording a review and enabling are two separate buttons on purpose. Approving a crawl and starting one
are two decisions, and one button doing both is the shortcut the gate exists to prevent.

If a row shows **No connector** instead of a toggle, no code queries that source. That is a fact about
the repository, so it changes in a migration alongside the connector that lands — not from this page.

## Reading a search result's source status

`SearchOutcome.sources` reports one status per requested source:

| `health` | Meaning |
|---|---|
| `ok` | contacted, answered |
| `timeout` | no response within `CONNECTOR_TIMEOUT_MS` (8s) |
| `failed` | errored or returned an unexpected shape |
| `disabled` | **never contacted** — switched off in the register |

`disabled` is its own value because folding it into `ok, 0 results` would tell a user the source had
nothing to say, and folding it into `failed` would tell them something is broken. Neither is true.

Switching a source off also drops its rows from any warm cache entry. Otherwise the kill switch would
have a five-minute tail during which the product still showed data from a withdrawn source.

## The four platforms that are registered and permanently unavailable

`linkedin`, `x`, `facebook`, `instagram`. Their terms prohibit automated collection and no permission is
on file, which is also why they appear in `HARD_BLOCKED_CONNECTOR_IDS`
(`src/lib/enrichment/policies.ts`).

They are registered so the UI can show *why* they are absent, not as a step toward enabling them. Three
constraints independently refuse the enabled state: there is no connector, the kind stores nothing, and
no terms review exists.

Enabling any of them is a decision with a named owner who has read that platform's terms and recorded a
lawful basis — and for a source of personal data about people who are not our users, in the EU, that
means an Article 14 notice too. The mechanism accepts that decision. It does not make it.

## Adding a solutions adapter

1. Add the source row in a migration, `enabled = false`, with `allowed_fields` listing exactly what the
   adapter will contribute.
2. Write the adapter implementing `SolutionSourceAdapter`, declaring `metadataKeys`.
3. Add its key to `SOLUTION_ADAPTERS` in `src/lib/solutions/sources/runner.ts`.
4. Any capability it claims must already be in `SOLUTION_CAPABILITIES`
   (`src/shared/lib/solutions/contracts.ts`) **and** seeded by a migration. The constant types every
   adapter's mapping table, so a misspelling is a compile error rather than a foreign-key violation on
   the first run.

`assertAdapterFieldsAreRegistered` compares step 1 against step 2 in both directions. Get it wrong and
the failure is silent: `filterToAllowedFields` drops what the register does not name, which is what makes
the register load-bearing and also why a snake_case/camelCase mismatch is invisible at runtime.

### Adding a `public_scrape` target

`createDocumentationCrawlAdapter(target)` is a factory over operator data, so adding a crawl target is a
register entry plus a recorded review — not a deploy. No real target is registered. Robots is checked per
path, and `unavailable` is treated as **disallowed**: not being able to check whether we are allowed is
not permission.

## Roles

| Role | `search_sources` / `solution_sources` |
|---|---|
| `builderhunt_app` | SELECT |
| `builderhunt_worker` | SELECT |
| `builderhunt_platform` | SELECT, INSERT, UPDATE |

Neither the app nor the worker can write. A worker able to enable its own data source would make the kill
switch decorative, which is the whole reason these tables exist. `scripts/db/verify-rls-local.mjs`
asserts both the grants and the denials, and has been checked in both directions.

Two related grants are narrower than they look, and deliberately:

- `solution_component_capabilities` — worker has SELECT and INSERT, **no UPDATE**. A claim keyed by
  `(component, version, capability)` is immutable content, and `evidence_level` is what a human raises to
  `verified`. Ingestion uses `ON CONFLICT DO NOTHING` so it does not need UPDATE. (Postgres decides a
  statement's required grants statically, so `DO UPDATE` would demand the privilege even on runs where
  nothing conflicts.)
- `solution_component_versions` — worker has `UPDATE (valid_until)` only. Closing a window is ingestion's
  job; rewriting a historical version's metadata would falsify the audit trail the versions exist to
  keep.

## Jobindex, specifically

Registered as `jobindex_roles` in `solution_sources`, ships disabled. It is a `feed`: Jobindex publishes
`https://www.jobindex.dk/jobsoegning.rss?q=<query>` and declares `ttl=1440`, honoured as the 24h refresh
interval.

Postings become `human_role` components — an employer describing a role it wants filled. **No candidate
data**: no contact name, recruiter or applicant detail is read even when a posting body contains one.
That is why it is not in `search_sources`.

Measured against the live feed on 2026-08-01, and worth knowing before trusting the data:

- 20 items per query.
- The `q` parameter is genuinely applied — `q=developer` and `q=designer` overlapped on only 5 of 20.
- Every item was a **promoted** listing. This is Jobindex's paid-placement inventory, not its full index.
- Relevance is loose: `q=developer` returned "Packaging Technical Assistant".

So these components are evidence that *someone in Denmark is advertising this role* — not a
representative sample of Danish hiring demand. A precise index would mean fetching the
`/jobsoegning?q=` HTML pages, which is a scrape and needs a recorded terms review.

The feed is ISO-8859-1 with the charset declared only in its XML prolog. The adapter passes
`fallbackCharset: 'iso-8859-1'` to `safeFetch`; without it every æ/ø/å decodes to a replacement character
that then becomes a permanent part of a component slug.

## Attribution obligations

Two sources make continued access conditional on crediting them, in their own words, served inside their
API responses:

| Source | Obligation |
|---|---|
| Remote OK | *"Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source ... If you do not we'll have to suspend API access."* Their logo is a registered trademark and must not be used; the name may be. |
| Jobicy | *"Please ensure Jobicy is clearly credited with a direct link to the source, and all application buttons redirect to the original job URL provided in this feed."* The second half is a product constraint, not just a credit. |

This is why `solution_sources` has `attribution_required`, `attribution_text` and `attribution_url` rather
than leaving it in `register_notes`. A note is prose that no code can read, so a UI could render results
with no link-back and access would be lost silently. A CHECK constraint keeps the three inseparable: a
source cannot claim to require attribution without saying what to show and where to link.

**Anything that renders a result must show it.** Admin → Sources displays the obligation on each affected
row so an operator sees what they are taking on at the moment they enable the source. The public Solutions
UI must do the same — that is part of binding the Solutions UI to real endpoints (plans/UI task 78), and it
is a release blocker for enabling either source in production, not a nice-to-have.

## Job feeds: market rate evidence, not retrieval candidates

Five sources contribute job postings: Jobindex, Arbeitnow, Remote OK, Jobicy, Himalayas. All five produce
`human_role` components with **no capability claims at all**, because a job ad states what an employer
wants and says nothing about what anyone can do.

The consequence is that they are **structurally invisible to retrieval**: the capability filter is a hard
array overlap, and a component claiming nothing can never match. That is correct and deliberate. The
tempting fix — deriving capabilities from posting titles — is exactly the inference the adapters refuse to
make, because "someone in Munich advertised for a Rust developer" is not evidence that a Rust developer
exists, is available, or can do a given brief's work.

What they are for is `findMarketRateBand` (`src/lib/solutions/retrieval/market-rates.ts`): an
advertised-salary band for a kind of role, which is where a route's cost estimate comes from. A band needs
at least five comparable postings in one currency, uses the median rather than the mean, excludes non-annual
figures rather than converting them, and returns `insufficient_data` rather than a wide guess.

Verified against 398 live postings: "software engineer" → USD p25 100,000 / median 125,000 / p75 163,600
from 24 samples, with 2 postings in other currencies counted and excluded.

## Sources with an adapter waiting on a credential

Not registered, because a register row for a source with neither an adapter nor a key promises something
that does not exist. Each of these is free with registration and would be implemented and verified against
its live API once a key exists — writing an adapter that has never run against the real endpoint is how
most of the defects recorded in this repository's Phase 4 and 5 notes were introduced.

| Source | Coverage | Credential needed |
|---|---|---|
| Adzuna | 16+ countries, structured salary and salary history | `app_id` + `app_key` |
| InfoJobs | Spain, 40k+ postings/day | Client ID + secret (HTTP Basic) |
| France Travail | France, public and private | OAuth2 client |
| JobTech Dev | Sweden, 12 months of history | API key |
| Arbeitsagentur | Germany, official | OAuth2 |
| The Muse | US/UK/CA, rich company profiles | `apiKey` |
| USAJOBS | US federal | API key (`Authorization-Key` header) |

## Identity: how source accounts become one person

`canonical_humans` is the entity a recruiter searches. Accounts reach it only through `decideLink`
(`src/shared/lib/human-identity/link-policy.ts`), which auto-approves four methods and sends everything
inferred to review. What was missing until 2026-08-01 was anything *producing* the deterministic methods —
the mechanism existed and had made zero links.

### The signal, in order of strength

| Evidence | Method | Outcome |
|---|---|---|
| The person proved control through the claim flow | `verified_claim` | auto-links, 100% precision |
| Two accounts each publicly name the other (`github.blog = dev.to/ben` **and** `devto.github_username = benhalpern`) | `explicit_cross_link`, bidirectional | auto-links, 9500 bps, **no network call** |
| An account declares a domain and the domain links back to that exact profile | `explicit_cross_link`, bidirectional | auto-links, 9500 bps |
| A Bluesky handle that is a domain, confirmed by `_atproto` DNS TXT | domain control proven | anchors the domain |
| One account names another, unreciprocated | `probabilistic` | **review queue** |
| Two accounts declare the same domain, unreciprocated | `probabilistic` | **review queue** |

**Reciprocity is the whole test.** A declaration is a claim — anyone can type any URL into a profile. What
makes it evidence is that the other side, which can only speak for itself, says the same thing.

### Why unreciprocated shared domains must never link

On the first real run, `rustdesk.com` was declared by **25 different GitHub accounts** — usernames like
`joyjoyiwvm` and `talexa723w2`, i.e. a spam campaign. A "same declared domain means same person" heuristic
would have merged 25 unrelated people into one canonical human. The site links back to none of them, so all
25 are `contradicted` and nothing was linked. That case is a permanent test
(`tests/unit/lib/identity/reciprocity.test.ts`).

### Running it

```bash
pnpm identity:verify --domains=25 --dry-run
```

Safe to re-run: only `declared` rows are checked, so an answered domain is not re-fetched. Each domain's
homepage is fetched once through `safeFetch`, honouring robots — and here `no_robots_file` is permission,
because RFC 9309 §2.3.1.3 says a 4xx on `/robots.txt` allows every resource and most personal sites have
none. `unavailable` still is not permission.

Drop `--dry-run` to unify. A group spanning two *existing* canonical humans is reported as
`needsMergeReview` and left alone: that is a merge, it affects tenant data pointing at either, and
`mergeCanonicalHumans` captures a restore snapshot first — an operator invokes it.

### Measured coverage, not projected

- 75% of GitHub profiles declare a site or a social handle.
- 46% of reachable sites link back → **~30% of accounts anchor on the first hop.**
- `rel="me"`, the IndieAuth microformat this design expected to use, matched **0 of 20** real developer
  sites. It is accepted as the stronger form where present and never required.
- GitHub's `/search/users` sends no `name`, `bio`, `location` or `followers`. Hydrating `/users/{login}` is
  what makes a person's record useful *and* what yields `blog` — before it, 1 of 43 GitHub people had a name.

The rest goes to the review queue, and claims are what close the gap: a verified claim is the strongest
method available and it is also the GDPR-clean path, because the person participates.

## Not integrated: social-analyzer

[qeeqbox/social-analyzer](https://github.com/qeeqbox/social-analyzer) was evaluated as an enrichment
source and rejected on two grounds:

1. **AGPL-3.0.** Linking it into the server would oblige us to offer BuilderHunt itself under AGPL via
   the network clause.
2. **It produces the one signal we already refuse to act on.** It enumerates username permutations across
   many sites, which is a `probabilistic` link signal — and `decideLink` in
   `src/shared/lib/human-identity/link-policy.ts` sends every probabilistic signal to `pending_review`
   regardless of score, by design. Its only sound use would be generating candidates for that review
   queue, which is a small amount of code over `safeFetch` and needs no AGPL dependency, webdriver, or
   OCR layer.


## The credentialed batch (migration 0139, 2026-08-02)

Seven sources registered **disabled**. Four of the seven parse a shape taken from published documentation
rather than from a response anyone has seen, and `src/lib/solutions/sources/credentialed-job-feeds.ts` states
which is which in its header table.

| Source | Credential | Shape evidence |
| --- | --- | --- |
| `jobtech_dev_jobs` | none (optional `JOBTECH_DEV_API_KEY` raises limits) | live probe 2026-08-02 |
| `themuse_jobs` | none for page 1 (`MUSE_API_KEY` raises limits) | live probe 2026-08-02 |
| `arbeitsagentur_jobs` | public client key, hard-coded | live probe 2026-08-02 |
| `adzuna_jobs` | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `ADZUNA_COUNTRY` | published docs, never run |
| `usajobs_jobs` | `USAJOBS_API_KEY`, `USAJOBS_USER_AGENT` | published docs, never run |
| `france_travail_jobs` | `FRANCE_TRAVAIL_ACCESS_TOKEN` | published docs, never run |
| `infojobs_jobs` | `INFOJOBS_CLIENT_ID`, `INFOJOBS_CLIENT_SECRET` | published docs, never run |

**Enabling one is a two-step act.** Turn it on, then run it and look at what landed — the first run is the test
these adapters never had. A documented shape that turns out to be wrong fails loudly as
`unexpected_response_shape` rather than reporting a successful run that stored nothing.

**`france_travail_jobs` is registered but not yet runnable.** Its auth is OAuth2 client-credentials, so the
bearer token is short-lived and cannot be a static environment variable. The adapter reads
`FRANCE_TRAVAIL_ACCESS_TOKEN`, which means something else has to mint it, and that exchange is not implemented.
Stated rather than stubbed: a token-fetching stub would be the least-tested code in the file.
