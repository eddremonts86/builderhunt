/**
 * The seven job sources that need a credential (plan 43 Phase 4, deferred until the keys existed).
 *
 * # Read this before enabling any of them
 *
 * **None of these has ever run against a live authenticated endpoint.** I said for most of this project that I
 * would not ship an adapter that had never run, and the maintainer decided otherwise on 2026-08-02 — the
 * decision is theirs, and this header is what keeps it honest rather than invisible.
 *
 * What that means in practice: every source here is registered **disabled**, and enabling one is a maintainer
 * act that should be followed immediately by a real run and a look at what landed. The first run is the test.
 *
 * ## What evidence each parser actually rests on
 *
 * | Source | Shape evidence | Auth verified? |
 * | --- | --- | --- |
 * | `jobtech_dev_jobs` | **Live probe 2026-08-02** — full hit inspected, no key needed | n/a, public |
 * | `themuse_jobs` | **Live probe 2026-08-02** — full result inspected, no key for page 1 | key only raises the rate limit |
 * | `arbeitsagentur_jobs` | **Live probe 2026-08-02** with the public client key | that key is public, so yes |
 * | `adzuna_jobs` | Published field list on developer.adzuna.com | no |
 * | `usajobs_jobs` | Published envelope (`SearchResult.SearchResultItems[].MatchedObjectDescriptor`) | no — 401 confirmed the header is required |
 * | `france_travail_jobs` | Published v2 offer shape | no — 401 confirmed OAuth is required |
 * | `infojobs_jobs` | Published v9 offer shape | no — 401 confirmed Basic auth is required |
 *
 * The bottom four parse a documented shape. A documented shape and a served shape are not the same thing, which
 * is why `unexpected_response_shape` is a **failure** and never an empty result: if the real payload differs,
 * the first run says so loudly instead of reporting success while storing nothing.
 *
 * ## Everything here is a `human_role`, and none of it claims a capability
 *
 * A job advertisement says what an employer wants. It never says what anyone can do, so `capabilities` is
 * always empty — the same rule the four public feeds follow, and the reason the composer can never offer a
 * posting as a person.
 */
import { safeFetch, SafeFetchError } from '~/lib/enrichment/network'
import { log } from '~/shared/lib/log'
import { htmlToPlainText } from './html-text'
import type { AdapterComponent, AdapterContext, AdapterOutcome, SolutionSourceAdapter } from './types'

const MAX_TAGS = 8
const MAX_SUMMARY = 600

/** Credentials come from the environment at collect time, never from the register or a request. */
export interface CredentialReader {
  (name: string): string | undefined
}

const readEnv: CredentialReader = (name) => process.env[name]

export interface CredentialedFeedJob {
  externalId: string
  roleTitle: string
  companyName: string | null
  area: string | null
  summary: string | null
  postingUrl: string
  publishedAt: string | null
  remote: boolean | null
  employmentType: string | null
  seniority: string | null
  salaryMin: number | null
  salaryMax: number | null
  salaryCurrency: string | null
  tags: string[]
}

export interface CredentialedFeedSpec {
  sourceKey: string
  hosts: readonly string[]
  /** Environment variables this source cannot run without. Missing any one fails the run, named. */
  requiredCredentials: readonly string[]
  /**
   * Builds one page's request. Returns `null` when the source has no further pages, and may return `null` on
   * page 1 if a credential turns out to be unusable — the runner treats that the same as "no more pages".
   */
  request: (page: number, pageSize: number, credential: CredentialReader) =>
    { url: string; headers?: Record<string, string> } | null
  parse: (body: string) => CredentialedFeedJob[] | null
}

// ── Shared coercion ────────────────────────────────────────────────────────────────────────────
//
// Deliberately duplicated from `job-feeds.ts` rather than imported. Those helpers carry that file's own
// history — the double-encoded UTF-8 repair exists because RemoteOK serves latin-1-read-as-UTF-8, and the
// placeholder-company guard exists because Himalayas served `companyName: "name"` for twenty minutes. Sharing
// them would make a future fix for one feed silently change eleven, which is how a repair for one source
// becomes a regression in another.

function toText(value: unknown, limit = 200): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, limit) : null
}

/** Several of these APIs serve HTML descriptions; two serve plain text. Both go through the same path. */
function toSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return htmlToPlainText(value, MAX_SUMMARY)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  // Adzuna serves salaries as numbers; France Travail serves a free-text `libelle`. A string that is not a
  // clean number is left null rather than regex-mined — a wrong salary is worse than a missing one.
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value))
  return null
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

function toTags(values: readonly unknown[]): string[] {
  return values
    .map((value) => toText(value, 40))
    .filter((tag): tag is string => tag !== null)
    .slice(0, MAX_TAGS)
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function asRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

// ── The seven specs ────────────────────────────────────────────────────────────────────────────

export const CREDENTIALED_JOB_FEEDS: Readonly<Record<string, CredentialedFeedSpec>> = Object.freeze({
  /**
   * Sweden's public employment service. **Verified live 2026-08-02** and it needs no key at all — the API key
   * mentioned in their docs raises limits rather than granting access. Registered here with the others because
   * it belongs to the same batch, not because it is credentialed.
   */
  jobtech_dev_jobs: {
    sourceKey: 'jobtech_dev_jobs',
    hosts: ['jobsearch.api.jobtechdev.se'],
    requiredCredentials: [],
    request: (page, pageSize, credential) => {
      const key = credential('JOBTECH_DEV_API_KEY')
      return {
        url: `https://jobsearch.api.jobtechdev.se/search?limit=${pageSize}&offset=${(page - 1) * pageSize}`,
        ...(key ? { headers: { 'api-key': key } } : {}),
      }
    },
    parse: (body) => {
      const hits = asRecordArray((safeJson(body) as { hits?: unknown } | null)?.hits)
      if (!hits) return null
      return hits.flatMap((hit) => {
        const id = toText(hit.id, 64)
        const title = toText(hit.headline)
        const url = toText(hit.webpage_url, 500)
        if (!id || !title || !url) return []
        const address = record(hit.workplace_address)
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toText(record(hit.employer).name, 200),
          // Municipality first, region as the fallback: an ad with no municipality is regional, and "Sweden"
          // alone would be worse than nothing.
          area: toText(address.municipality, 120) ?? toText(address.region, 120),
          summary: toSummary(record(hit.description).text),
          postingUrl: url,
          publishedAt: toIsoDate(hit.publication_date),
          // `remote_work` is a real tri-state here: true, false, or genuinely unknown. Preserved rather than
          // coerced, because "we do not know" is not "no".
          remote: typeof hit.remote_work === 'boolean' ? hit.remote_work : null,
          employmentType: toText(record(hit.employment_type).label, 60),
          seniority: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          // The taxonomy labels, not the concept ids: an id like `fg7B_yov_smw` matches nothing a person types.
          tags: toTags([record(hit.occupation).label, record(hit.occupation_group).label,
            record(hit.working_hours_type).label]),
        }]
      })
    },
  },

  /**
   * The Muse. **Verified live 2026-08-02**; page 1 answers without a key, and `MUSE_API_KEY` raises the rate
   * limit. Their `contents` field is HTML.
   */
  themuse_jobs: {
    sourceKey: 'themuse_jobs',
    hosts: ['www.themuse.com'],
    requiredCredentials: [],
    request: (page, _pageSize, credential) => {
      const key = credential('MUSE_API_KEY')
      // Page size is theirs to choose — the endpoint takes a page number and nothing else.
      return { url: `https://www.themuse.com/api/public/jobs?page=${page}${key ? `&api_key=${encodeURIComponent(key)}` : ''}` }
    },
    parse: (body) => {
      const results = asRecordArray((safeJson(body) as { results?: unknown } | null)?.results)
      if (!results) return null
      return results.flatMap((job) => {
        const id = job.id === undefined ? null : toText(String(job.id), 64)
        const title = toText(job.name)
        const url = toText(record(job.refs).landing_page, 500)
        if (!id || !title || !url) return []
        const locations = Array.isArray(job.locations) ? job.locations.map((entry) => record(entry).name) : []
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toText(record(job.company).name, 200),
          area: toTags(locations).join(', ') || null,
          summary: toSummary(job.contents),
          postingUrl: url,
          publishedAt: toIsoDate(job.publication_date),
          // "Flexible / Remote" appears as a location name rather than a flag.
          remote: locations.some((name) => typeof name === 'string' && /remote/i.test(name)) ? true : null,
          employmentType: null,
          seniority: toText(record((job.levels as unknown[] | undefined)?.[0]).name, 60),
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          tags: toTags((Array.isArray(job.categories) ? job.categories : []).map((entry) => record(entry).name)),
        }]
      })
    },
  },

  /**
   * Germany's Bundesagentur für Arbeit. **Verified live 2026-08-02** with `X-API-Key: jobboerse-jobsuche`,
   * which is the public client key their own web app sends — not a secret, and hard-coded here for that reason.
   * `ARBEITSAGENTUR_API_KEY` overrides it if they ever issue per-partner keys.
   *
   * Their payload carries no description at all in the search response, only a title, an employer and a place;
   * the full text needs a second call per posting, which is a rate-limit decision rather than a parsing one and
   * is deliberately not made here.
   */
  arbeitsagentur_jobs: {
    sourceKey: 'arbeitsagentur_jobs',
    hosts: ['rest.arbeitsagentur.de'],
    requiredCredentials: [],
    request: (page, pageSize, credential) => ({
      url: `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?size=${pageSize}&page=${page}`,
      headers: { 'X-API-Key': credential('ARBEITSAGENTUR_API_KEY') ?? 'jobboerse-jobsuche' },
    }),
    parse: (body) => {
      const offers = asRecordArray((safeJson(body) as { stellenangebote?: unknown } | null)?.stellenangebote)
      if (!offers) return null
      return offers.flatMap((offer) => {
        const reference = toText(offer.refnr, 64)
        const title = toText(offer.titel) ?? toText(offer.beruf)
        if (!reference || !title) return []
        const place = record(offer.arbeitsort)
        return [{
          externalId: reference,
          roleTitle: title,
          companyName: toText(offer.arbeitgeber, 200),
          area: toText(place.ort, 120),
          // No description in the search payload. Left null rather than filled with the title.
          summary: null,
          postingUrl: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(reference)}`,
          publishedAt: toIsoDate(offer.aktuelleVeroeffentlichungsdatum),
          remote: null,
          employmentType: null,
          seniority: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          tags: toTags([offer.beruf]),
        }]
      })
    },
  },

  /**
   * Adzuna. Shape from their published field list; **never run**, because it needs `app_id` and `app_key`.
   *
   * Country is part of the path, so `ADZUNA_COUNTRY` selects one. Defaulting to `gb` rather than guessing from
   * a locale: a wrong country returns a valid-looking page of the wrong market, which is worse than an error.
   */
  adzuna_jobs: {
    sourceKey: 'adzuna_jobs',
    hosts: ['api.adzuna.com'],
    requiredCredentials: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    request: (page, pageSize, credential) => {
      const id = credential('ADZUNA_APP_ID')
      const key = credential('ADZUNA_APP_KEY')
      if (!id || !key) return null
      const country = credential('ADZUNA_COUNTRY') ?? 'gb'
      return {
        url: `https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${page}`
          + `?app_id=${encodeURIComponent(id)}&app_key=${encodeURIComponent(key)}`
          + `&results_per_page=${pageSize}&content-type=application/json`,
      }
    },
    parse: (body) => {
      const results = asRecordArray((safeJson(body) as { results?: unknown } | null)?.results)
      if (!results) return null
      return results.flatMap((job) => {
        const id = job.id === undefined ? null : toText(String(job.id), 64)
        const title = toText(job.title)
        const url = toText(job.redirect_url, 500)
        if (!id || !title || !url) return []
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toText(record(job.company).display_name, 200),
          area: toText(record(job.location).display_name, 120),
          // Their docs say the description is a snippet, not the full text. Stored as what it is.
          summary: toSummary(job.description),
          postingUrl: url,
          publishedAt: toIsoDate(job.created),
          remote: null,
          employmentType: toText(job.contract_time, 60) ?? toText(job.contract_type, 60),
          seniority: null,
          // `salary_is_predicted` is Adzuna's own model output, not the employer's figure. A predicted salary
          // would feed a cost estimate the employer never stated, so it is dropped rather than stored.
          salaryMin: job.salary_is_predicted === '1' ? null : toNumber(job.salary_min),
          salaryMax: job.salary_is_predicted === '1' ? null : toNumber(job.salary_max),
          salaryCurrency: null,
          tags: toTags([record(job.category).label]),
        }]
      })
    },
  },

  /**
   * USAJOBS. Shape from their published envelope; **never run** — a probe on 2026-08-02 returned 401, which
   * confirms the `Authorization-Key` header is required and nothing else.
   *
   * `USAJOBS_USER_AGENT` is not decoration: their terms require a contact address in the User-Agent, and a
   * request without one is refused.
   */
  usajobs_jobs: {
    sourceKey: 'usajobs_jobs',
    hosts: ['data.usajobs.gov'],
    requiredCredentials: ['USAJOBS_API_KEY', 'USAJOBS_USER_AGENT'],
    request: (page, pageSize, credential) => {
      const key = credential('USAJOBS_API_KEY')
      const agent = credential('USAJOBS_USER_AGENT')
      if (!key || !agent) return null
      return {
        url: `https://data.usajobs.gov/api/search?ResultsPerPage=${Math.min(pageSize, 500)}&Page=${page}`,
        headers: { Host: 'data.usajobs.gov', 'User-Agent': agent, 'Authorization-Key': key },
      }
    },
    parse: (body) => {
      const items = asRecordArray(record((safeJson(body) as { SearchResult?: unknown } | null)?.SearchResult).SearchResultItems)
      if (!items) return null
      return items.flatMap((item) => {
        const job = record(item.MatchedObjectDescriptor)
        const id = toText(item.MatchedObjectId, 64) ?? toText(job.PositionID, 64)
        const title = toText(job.PositionTitle)
        const url = toText(job.PositionURI, 500) ?? toText(job.ApplyURI, 500)
        if (!id || !title || !url) return []
        const pay = record((job.PositionRemuneration as unknown[] | undefined)?.[0])
        const locations = Array.isArray(job.PositionLocation)
          ? job.PositionLocation.map((entry) => record(entry).LocationName)
          : []
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toText(job.OrganizationName, 200) ?? toText(job.DepartmentName, 200),
          area: toTags(locations).join(', ') || null,
          summary: toSummary(job.QualificationSummary ?? record(job.UserArea).Details),
          postingUrl: url,
          publishedAt: toIsoDate(job.PublicationStartDate),
          remote: null,
          employmentType: toText(record((job.PositionSchedule as unknown[] | undefined)?.[0]).Name, 60),
          seniority: null,
          salaryMin: toNumber(pay.MinimumRange),
          salaryMax: toNumber(pay.MaximumRange),
          // Federal pay is USD by definition, and this is the one place a currency can be asserted without
          // guessing.
          salaryCurrency: 'USD',
          tags: toTags([record((job.JobCategory as unknown[] | undefined)?.[0]).Name]),
        }]
      })
    },
  },

  /**
   * France Travail (formerly Pôle emploi), Offres d'emploi v2. Shape from their published documentation;
   * **never run** — a probe on 2026-08-02 returned 401.
   *
   * Their auth is OAuth2 client-credentials, so the token is short-lived and cannot be a static environment
   * variable. `FRANCE_TRAVAIL_ACCESS_TOKEN` is read here as a bearer token, which means **something else has to
   * mint it**. That token exchange is not implemented, and this adapter will stay unusable until it is — stated
   * rather than stubbed, because a stub that fetched a token would be the least-tested code in the file.
   */
  france_travail_jobs: {
    sourceKey: 'france_travail_jobs',
    hosts: ['api.francetravail.io'],
    requiredCredentials: ['FRANCE_TRAVAIL_ACCESS_TOKEN'],
    request: (page, pageSize, credential) => {
      const token = credential('FRANCE_TRAVAIL_ACCESS_TOKEN')
      if (!token) return null
      // Their paging is an inclusive `range=start-end`, not a page number.
      const start = (page - 1) * pageSize
      return {
        url: `https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search?range=${start}-${start + pageSize - 1}`,
        headers: { Authorization: `Bearer ${token}` },
      }
    },
    parse: (body) => {
      const results = asRecordArray((safeJson(body) as { resultats?: unknown } | null)?.resultats)
      if (!results) return null
      return results.flatMap((offer) => {
        const id = toText(offer.id, 64)
        const title = toText(offer.intitule)
        const url = toText(record(offer.origineOffre).urlOrigine, 500)
        if (!id || !title || !url) return []
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toText(record(offer.entreprise).nom, 200),
          area: toText(record(offer.lieuTravail).libelle, 120),
          summary: toSummary(offer.description),
          postingUrl: url,
          publishedAt: toIsoDate(offer.dateCreation),
          remote: null,
          employmentType: toText(offer.typeContratLibelle, 60) ?? toText(offer.typeContrat, 60),
          seniority: toText(record(offer.experienceLibelle), 60),
          // `salaire.libelle` is free text ("Annuel de 30000 à 35000 Euros"). Not mined: a regex over a
          // free-text salary is exactly the kind of guess a cost estimate must not rest on.
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          tags: toTags([offer.romeLibelle, offer.secteurActiviteLibelle]),
        }]
      })
    },
  },

  /**
   * InfoJobs (Spain), API v9. Shape from their published documentation; **never run** — a probe on 2026-08-02
   * returned 401.
   *
   * Auth is HTTP Basic with `client_id:client_secret`, so the credential is derivable from two variables and
   * the header is built here rather than stored pre-encoded.
   */
  infojobs_jobs: {
    sourceKey: 'infojobs_jobs',
    hosts: ['api.infojobs.net'],
    requiredCredentials: ['INFOJOBS_CLIENT_ID', 'INFOJOBS_CLIENT_SECRET'],
    request: (page, pageSize, credential) => {
      const id = credential('INFOJOBS_CLIENT_ID')
      const secret = credential('INFOJOBS_CLIENT_SECRET')
      if (!id || !secret) return null
      return {
        url: `https://api.infojobs.net/api/9/offer?page=${page}&maxResults=${Math.min(pageSize, 50)}`,
        headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
      }
    },
    parse: (body) => {
      const items = asRecordArray((safeJson(body) as { items?: unknown } | null)?.items)
      if (!items) return null
      return items.flatMap((offer) => {
        const id = toText(offer.id, 64)
        const title = toText(offer.title)
        const url = toText(offer.link, 500)
        if (!id || !title || !url) return []
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toText(record(offer.author).name, 200),
          area: toText(offer.city, 120) ?? toText(record(offer.province).value, 120),
          summary: toSummary(offer.requirementMin ?? offer.description),
          postingUrl: url,
          publishedAt: toIsoDate(offer.published),
          remote: null,
          employmentType: toText(record(offer.contractType).value, 60),
          seniority: toText(record(offer.experienceMin).value, 60),
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          tags: toTags([record(offer.category).value, record(offer.subcategory).value]),
        }]
      })
    },
  },
})

// ── The adapter ────────────────────────────────────────────────────────────────────────────────

/**
 * Builds the adapter for one credentialed feed.
 *
 * The one behavioural difference from `createJobFeedAdapter`: a missing credential is **`skipped`**, not
 * `failed`. A source nobody has provisioned keys for is not broken, and reporting it as a failure would put a
 * permanent red mark on every run until someone either finds keys or deletes the source — which teaches an
 * operator to ignore the colour.
 */
export function createCredentialedJobFeedAdapter(
  spec: CredentialedFeedSpec,
  credential: CredentialReader = readEnv,
): SolutionSourceAdapter {
  return {
    sourceKey: spec.sourceKey,
    acquisitionMode: 'feed',
    requiredHosts: spec.hosts,
    metadataKeys: [
      'roleTitle', 'companyName', 'area', 'summary', 'postingUrl', 'publishedAt',
      'remote', 'employmentType', 'seniority', 'salaryMin', 'salaryMax', 'salaryCurrency', 'tags',
    ],

    async collect(context: AdapterContext): Promise<AdapterOutcome> {
      const missing = spec.requiredCredentials.filter((name) => !credential(name))
      if (missing.length > 0) {
        /**
         * `failed`, and named. `AdapterOutcome` has three kinds and this is precisely the one the type
         * documents — "cannot proceed and retrying will not help ... a revoked key". A missing key is that.
         *
         * A fourth `skipped` kind was the first instinct, to keep an unprovisioned source from showing red. It
         * is not needed: every source here ships **disabled**, so the runner never reaches this branch until an
         * operator deliberately turns one on — and at that moment "missing_credentials:ADZUNA_APP_ID" is
         * exactly what they need to see, not a quiet skip.
         */
        log.warn('solutions_adapter_missing_credential', { sourceKey: spec.sourceKey, missing })
        return { kind: 'failed', reason: `missing_credentials:${missing.join(',')}` }
      }

      const components: AdapterComponent[] = []
      const seen = new Set<string>()
      const pageSize = Math.min(context.limit, 50)

      for (let page = 1; page <= 20; page += 1) {
        if (context.signal.aborted) break
        if (components.length >= context.limit) break

        const request = spec.request(page, pageSize, credential)
        if (!request) break

        let response
        try {
          response = await safeFetch(request.url, {
            allowedHosts: context.allowedHosts,
            signal: context.signal,
            headers: { Accept: 'application/json', ...request.headers },
          })
        } catch (error) {
          if (error instanceof SafeFetchError) {
            if (error.code === 'rate_limited') return { kind: 'retry', reason: 'rate_limited' }
            if (error.code === 'upstream_error' || error.code === 'timeout') {
              return { kind: 'retry', reason: 'upstream_unavailable', detail: error.code }
            }
            if (page === 1) return { kind: 'failed', reason: error.code }
            log.warn('credentialed_feed_page_refused', { sourceKey: spec.sourceKey, page, code: error.code })
            break
          }
          return { kind: 'failed', reason: error instanceof Error ? error.message : 'unknown' }
        }

        if (response.status === 429) return { kind: 'retry', reason: 'rate_limited' }
        // 401/403 is a credential problem, and it is a *failure* rather than a skip: keys were provided and
        // rejected, which someone has to fix. Distinguished from the missing-credential skip above on purpose.
        if (response.status === 401 || response.status === 403) {
          return { kind: 'failed', reason: `credential_rejected_http_${response.status}` }
        }
        if (response.status >= 500) return { kind: 'retry', reason: 'upstream_unavailable' }
        if (response.status !== 200) {
          if (page === 1) return { kind: 'failed', reason: `http_${response.status}` }
          break
        }

        const jobs = spec.parse(response.body)
        // The load-bearing line for the four adapters that have never run. A documented shape that turns out to
        // differ fails loudly here instead of reporting a successful run that stored nothing.
        if (jobs === null) return { kind: 'failed', reason: 'unexpected_response_shape' }
        if (jobs.length === 0) break

        for (const job of jobs) {
          if (components.length >= context.limit) break
          const slug = `${spec.sourceKey}-${job.externalId}`
          if (seen.has(slug)) continue
          seen.add(slug)
          components.push(toComponent(spec.sourceKey, slug, job))
        }
      }

      log.info('solutions_adapter_collected', { sourceKey: spec.sourceKey, found: components.length })
      return { kind: 'components', components }
    },
  }
}

function toComponent(sourceKey: string, slug: string, job: CredentialedFeedJob): AdapterComponent {
  return {
    kind: 'human_role',
    slug,
    displayName: job.roleTitle,
    externalId: job.externalId,
    homepageUrl: job.postingUrl,
    metadata: {
      roleTitle: job.roleTitle,
      companyName: job.companyName,
      area: job.area,
      summary: job.summary,
      postingUrl: job.postingUrl,
      publishedAt: job.publishedAt,
      remote: job.remote,
      employmentType: job.employmentType,
      seniority: job.seniority,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      salaryCurrency: job.salaryCurrency,
      tags: job.tags,
    },
    // A job advertisement never states what a person can do. Always empty.
    capabilities: [],
    sourceUrl: job.postingUrl,
  }
}

export const CREDENTIALED_JOB_FEED_ADAPTERS: readonly SolutionSourceAdapter[] =
  Object.values(CREDENTIALED_JOB_FEEDS).map((spec) => createCredentialedJobFeedAdapter(spec))
