# Source register — per-source legal review sheet

**Status: prepared for review, nothing approved.** Written 2026-08-02. Each sheet below states what the source
is, what its terms say *in its own words*, what personal data is involved, and what is already enforced in code.
The determination column is empty on purpose — filling it in is the reviewer's job, and
`plans/phase-5/01-production-readiness-audit` is where the gate lives.

## How to use this

One decision per source, and the decision is binary: **may this source be enabled, yes or no**, with any
conditions written down. A `public_scrape` source additionally cannot be enabled until a terms review is
*recorded in the database* — `solution_sources_scrape_needs_review_check` refuses otherwise, so the sign-off is
enforced rather than remembered.

Recording a review is a separate admin action from enabling a source
(`POST /api/admin/solutions/sources`, action `record-review`). That split is deliberate: one click must not both
approve and switch on a crawl.

## The register as it stands

Twelve sources. Seven are enabled, five are not, and three of the five have no adapter at all — registering a
source and being able to ingest from it are different things.

---

### `arbeitnow_jobs` — feed, **enabled**

- **What it is:** public job-board API, no authentication (`arbeitnow.com/blog/job-board-api`).
- **Their terms:** no stated attribution requirement found.
- **Personal data:** none. Job postings name employers, not people.
- **Probed:** 2026-08-01, 175 postings.
- **Enforced in code:** 13 allowlisted fields; nothing outside them is stored.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `himalayas_jobs` — feed, **enabled**

- **What it is:** public JSON API, no authentication.
- **Their terms:** no stated attribution requirement found.
- **Personal data:** none.
- **Probed:** 2026-08-01. Note their API served `companyName: "name"` as a literal placeholder for every posting
  for about twenty minutes; the adapter refuses placeholder company names rather than storing them.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `jobicy_jobs` — feed, **enabled**, attribution required

- **Their terms, verbatim from the response body:** *"Please ensure Jobicy is clearly credited with a direct
  link to the source, and all application buttons redirect to the original job URL provided in this feed."*
- **The second half is a product constraint, not a credit.** An apply button must go to their URL. Any surface
  that ever renders an apply action for this data has to honour it.
- **Personal data:** none.
- **Enforced in code:** `attribution_required` with the text and URL stored; the run payload carries it and
  `RunResult` renders it. `solution_sources_attribution_complete_check` refuses a required attribution with no
  text or URL.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `remoteok_jobs` — feed, **enabled**, attribution required

- **Their terms, verbatim from the response body:** *"Please link back (with follow, and without nofollow!) to
  the URL on Remote OK and mention Remote OK as a source ... If you do not we'll have to suspend API access."*
- **Trademark:** the logo is registered and must not be used. The name may be.
- **A conflict worth the reviewer's attention:** they require a **followed** link. The attribution footer
  currently renders `rel="noreferrer noopener nofollow"`, which is the safe default for outbound links and is
  the opposite of what they ask. Either the link for this source drops `nofollow`, or the requirement is not
  met. Engineering has not decided this because it trades an SEO/abuse default against a contractual term.
- **Personal data:** none.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `jobindex_roles` — feed, **enabled**

- **What it is:** official RSS feed. Produces `human_role` components — roles Danish employers are hiring for.
- **Why it is not candidate data:** a job ad states what an employer wants, never what a person can do. No
  capability claim is ever derived from one, and the composer refuses to offer a `human_role` as a person.
- **Personal data:** company names are corporate identifiers.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `huggingface_models` — official API, **enabled**

- **What it is:** documented public HTTP API. Model-card fields only.
- **Capabilities:** `pipeline_tag` mapped to our vocabulary by exact lookup; an unmapped tag yields no claim.
- **Personal data:** model authors' handles appear in model ids. Worth a reviewer's eye — a handle is a
  pseudonymous identifier and arguably personal data even though nothing about the person is stored.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `npm_registry` — official API, **enabled**

- **What it is:** the registry endpoint every package manager already calls.
- **Capabilities:** exact keyword allowlist, never a fuzzy match.
- **Personal data:** maintainer handles and, in some manifests, email addresses. Same question as Hugging Face.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

---

### `linkedin_profiles` — external link only, **disabled**, no adapter

- **Their terms:** `linkedin.com/legal/crawling-terms` prohibits automated collection, and no permission is on
  file.
- **Position:** outbound links only. Nothing fetched from this host is stored, and there is no adapter to write.
- **This is the reference case** the other refusals are measured against.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| Keep link-only | — | — | — |

### `remotive_jobs` — feed, **disabled**, no adapter

- **Their terms, verbatim:** *"Displaying our jobs in order to collect signups/email addresses to show a listing
  constitutes a breach of our terms of services."*
- **Why engineering stopped:** BuilderHunt is a product people sign up for. Whether that clause covers us is a
  judgement with real consequences — their private API starts at $5k/mo — and it is the maintainer's, not a
  migration's.
- **Also:** max 4 requests/day, mandatory link-back, and a deliberate 24-hour delay on the data.
- **Enforced in code:** `allowed_fields` is empty, so nothing could be stored even if an adapter appeared.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `thehub_startups` — public scrape, **disabled**, no adapter

- **What it is:** `thehub.io` has an internal JSON endpoint third-party scrapers use. An undocumented internal
  endpoint is not a published API — the same reasoning that keeps LinkedIn adapter-less.
- **Personal data:** founder names and LinkedIn links appear in the data. That makes it personal data, not
  merely company data.
- **Enforced in code:** registered as `public_scrape`, so the database refuses to enable it without a recorded
  terms review.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `mcp_servers_registry` — feed, **disabled**, no adapter

- Published directory feed. Registered but never ingests; enabling it has no effect until an adapter lands.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

### `generic_human_roles` — user submission, **disabled**

- Authored in-house, not ingested. Provides the generic `human_role` components the composer pairs with agents
  when no specific person is required. No third party and no personal data.

| Determination | Conditions | Reviewer | Date |
| --- | --- | --- | --- |
| — | — | — | — |

---

## Two questions that cut across the register

1. **Are public developer handles personal data for this purpose?** `huggingface_models` and `npm_registry`
   store maintainer handles, and the canonical-human system links handles across platforms into one person.
   Individually each handle is a public identifier; together they are a profile. That is the same tension the
   AI Act draft raises about the human lane, and it deserves one answer rather than two.

2. **The `nofollow` conflict in `remoteok_jobs`.** A contractual term asks for a followed link and the platform's
   safe default is `nofollow`. Whichever way this goes, it should be a decision recorded here rather than a
   default nobody noticed.

Related: `docs/operations/source-register.md` (the operational register),
`docs/compliance/solutions-ai-act-classification.md`,
`plans/phase-5/01-production-readiness-audit/tasks.md` (where the gate lives).
