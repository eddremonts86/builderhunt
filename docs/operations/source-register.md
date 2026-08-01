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
