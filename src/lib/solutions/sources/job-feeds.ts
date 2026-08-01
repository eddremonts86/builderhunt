/**
 * The public job-feed APIs: Arbeitnow, Remote OK, Jobicy, Himalayas.
 *
 * One skeleton and four small mappers rather than four near-identical adapters. What differs between these
 * sources is only the field names in their JSON; what they need in common — bounded fetch, host allowlist,
 * a normalized `human_role` component, no capability claims, a stable external id — is the part worth
 * having exactly once.
 *
 * **What these contribute.** Job postings: an employer describing a role it wants filled. Demand-side
 * market signal, and never candidate data — no contact name, recruiter or applicant detail is read even
 * where a posting body contains one. Same reasoning as `jobindex.ts`, which is why these live in
 * `solution_sources` and not in `search_sources`.
 *
 * **No capability claims, ever.** A job ad states what an employer wants; it says nothing about what
 * anyone can do. Claiming otherwise would let the composer treat "someone advertised for a Rust developer"
 * as evidence that a Rust developer exists and is available.
 *
 * **Salary is read where offered**, because it is the one thing these feeds provide that the composer
 * genuinely needs: a human route's cost estimate has to come from somewhere, and a market rate for the
 * role is better evidence than a guess. Bounded by each source's `allowed_fields` as usual.
 *
 * Every endpoint here was probed live before being written, and two facts came out of that rather than out
 * of any documentation: `arbeitnow.com` 301-redirects to `www.arbeitnow.com`, and Remote OK serves
 * double-encoded UTF-8 in non-ASCII titles. Both are handled below.
 */
import { safeFetch, SafeFetchError } from '~/lib/enrichment/network'
import { log } from '~/shared/lib/log'
import { decodeHtmlEntities, htmlToPlainText } from './html-text'
import type { AdapterComponent, AdapterContext, AdapterOutcome, SolutionSourceAdapter } from './types'

/** Normalized posting, before it becomes a component. */
interface FeedJob {
  /** Stable within the source. Becomes the component's `externalId`. */
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

interface JobFeedSpec {
  sourceKey: string
  /** Hosts the adapter needs. More than one where a documented host redirects to another. */
  hosts: readonly string[]
  /** Built per page. Returning null means there are no further pages. */
  url: (page: number, limit: number) => string | null
  /** Extracts postings from one response body. Throws nothing — a shape it does not recognise returns
   * null so the runner can report `failed` rather than a silent empty batch. */
  parse: (body: string) => FeedJob[] | null
}

const MAX_TAGS = 12
const SUMMARY_LIMIT = 500

// ── Shared helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Repairs text that was encoded UTF-8, decoded as latin-1, and re-encoded UTF-8.
 *
 * Remote OK does this: "Thực Tập Sinh" arrives as "Thá»±c Táº­p Sinh". Storing it would put permanent
 * mojibake in a component's display name and slug.
 *
 * Guarded, because a blind round-trip would corrupt text that is legitimately latin-1-shaped. The repair
 * is applied only when the bytes actually decode as valid UTF-8 *and* the result differs — measured against
 * the live feed on 2026-08-01, that was 3 of 100 titles, with 96 pure ASCII (untouched) and 1 non-ASCII
 * title that does not round-trip (left alone, correctly).
 */
export function repairDoubleEncodedUtf8(value: string): string {
  // Escapes, not literal characters: the low end of this range is U+0080, which is invisible in source
  // and would be silently destroyed by any editor or tool that normalises control characters.
  if (!/[\u0080-\u00ff]/.test(value)) return value
  // A code point above U+00FF proves the string is already correctly decoded: the mis-encoding this
  // repairs can only ever produce characters inside the latin-1 range.
  for (const character of value) {
    if (character.codePointAt(0)! > 0xff) return value
  }
  try {
    const bytes = Uint8Array.from([...value].map((char) => char.codePointAt(0)!))
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return decoded.length > 0 ? decoded : value
  } catch {
    // Not double-encoded — the bytes are not valid UTF-8, so the original is what the source meant.
    return value
  }
}

/** Prose for a catalog summary. The decode-then-strip order lives in `htmlToPlainText`; see its note. */
function toSummary(value: unknown): string | null {
  return typeof value === 'string' ? htmlToPlainText(value, SUMMARY_LIMIT) : null
}

/**
 * Company names a feed emits that are serialization artifacts rather than companies.
 *
 * Observed live on 2026-08-01: the Himalayas API returned `"companyName": "name"` for every posting in a
 * response, twenty minutes after the same endpoint had returned real names. Their bug, but storing it is
 * ours — "name" as a company is a false statement about a company, and it would end up in a component's
 * metadata and in the lexical index.
 *
 * Deliberately a tiny exact-match list, not a heuristic. A rule like "reject suspiciously short names"
 * would discard real companies; this rejects exactly the artifacts that have been seen.
 */
const PLACEHOLDER_COMPANY_NAMES = new Set(['name', 'null', 'undefined', 'company', 'companyname', 'n/a', '-'])

/** A company we cannot name is `null`, which is honest, rather than a placeholder, which is a false claim. */
function toCompanyName(value: unknown): string | null {
  const text = toText(value)
  if (!text) return null
  return PLACEHOLDER_COMPANY_NAMES.has(text.toLowerCase()) ? null : text
}

function toText(value: unknown, limit = 200): string | null {
  if (typeof value !== 'string') return null
  const trimmed = repairDoubleEncodedUtf8(value).trim()
  return trimmed.length > 0 ? trimmed.slice(0, limit) : null
}

function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((tag): tag is string => typeof tag === 'string')
    // Entity-decoded: Jobicy serves `Product &amp; Operations`, and an index term containing `&amp;`
    // matches nothing a person would type.
    .map((tag) => toText(decodeHtmlEntities(tag), 40))
    .filter((tag): tag is string => tag !== null && !tag.includes(':'))
    .slice(0, MAX_TAGS)
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** Epoch seconds or an ISO string, both of which appear across these four feeds. */
function toIsoDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds, not milliseconds: all four feeds use seconds, and a millisecond value would land in the
    // year 58000 rather than failing visibly.
    const date = new Date(value * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  return null
}

function asRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
}

// ── The four feeds ─────────────────────────────────────────────────────────────────────────────

export const JOB_FEEDS: Readonly<Record<string, JobFeedSpec>> = Object.freeze({
  arbeitnow_jobs: {
    sourceKey: 'arbeitnow_jobs',
    // Both hosts: the documented one redirects to the other, and `safeFetch` revalidates every hop against
    // the allowlist, so omitting `www` fails the request on its first redirect.
    hosts: ['arbeitnow.com', 'www.arbeitnow.com'],
    url: (page) => (page === 1 ? 'https://www.arbeitnow.com/api/job-board-api' : null),
    parse: (body) => {
      const parsed = safeJson(body)
      const jobs = asRecordArray((parsed as { data?: unknown } | null)?.data)
      if (!jobs) return null
      return jobs.flatMap((job) => {
        const slug = toText(job.slug, 200)
        const title = toText(job.title)
        const url = toText(job.url, 500)
        if (!slug || !title || !url) return []
        return [{
          externalId: slug,
          roleTitle: title,
          companyName: toCompanyName(job.company_name),
          area: toText(job.location, 120),
          summary: toSummary(job.description),
          postingUrl: url,
          publishedAt: toIsoDate(job.created_at),
          remote: typeof job.remote === 'boolean' ? job.remote : null,
          employmentType: toTags(job.job_types)[0] ?? null,
          seniority: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          tags: toTags(job.tags),
        }]
      })
    },
  },

  remoteok_jobs: {
    sourceKey: 'remoteok_jobs',
    hosts: ['remoteok.com'],
    url: (page) => (page === 1 ? 'https://remoteok.com/api' : null),
    parse: (body) => {
      const parsed = safeJson(body)
      const all = asRecordArray(parsed)
      if (!all) return null
      // The first element is their legal notice, not a job. Dropping it by position rather than by
      // inspecting it: the shape of that element is theirs to change, and a posting without an `id` is
      // skipped below anyway.
      return all.slice(1).flatMap((job) => {
        const id = job.id === undefined ? null : toText(String(job.id), 64)
        const title = toText(job.position)
        const url = toText(job.url, 500)
        if (!id || !title || !url) return []
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toCompanyName(job.company),
          area: toText(job.location, 120),
          summary: toSummary(job.description),
          postingUrl: url,
          publishedAt: toIsoDate(job.date ?? job.epoch),
          // Every posting on Remote OK is remote — that is the entire premise of the site.
          remote: true,
          employmentType: null,
          seniority: null,
          salaryMin: toNumber(job.salary_min),
          salaryMax: toNumber(job.salary_max),
          // Their salary fields carry no currency. Left null rather than assumed to be USD: a wrong
          // currency on a cost estimate is worse than a missing one.
          salaryCurrency: null,
          tags: toTags(job.tags),
        }]
      })
    },
  },

  jobicy_jobs: {
    sourceKey: 'jobicy_jobs',
    hosts: ['jobicy.com'],
    url: (page, limit) => (page === 1 ? `https://jobicy.com/api/v2/remote-jobs?count=${Math.min(limit, 50)}` : null),
    parse: (body) => {
      const parsed = safeJson(body)
      const jobs = asRecordArray((parsed as { jobs?: unknown } | null)?.jobs)
      if (!jobs) return null
      return jobs.flatMap((job) => {
        const id = job.id === undefined ? null : toText(String(job.id), 64)
        const title = toText(job.jobTitle)
        const url = toText(job.url, 500)
        if (!id || !title || !url) return []
        return [{
          externalId: id,
          roleTitle: title,
          companyName: toCompanyName(job.companyName),
          area: toText(job.jobGeo, 120),
          summary: toSummary(job.jobExcerpt ?? job.jobDescription),
          postingUrl: url,
          publishedAt: toIsoDate(job.pubDate),
          remote: true,
          employmentType: toTags(job.jobType)[0] ?? null,
          seniority: toText(job.jobLevel, 60),
          salaryMin: toNumber(job.salaryMin),
          salaryMax: toNumber(job.salaryMax),
          salaryCurrency: toText(job.salaryCurrency, 3),
          tags: toTags(job.jobIndustry),
        }]
      })
    },
  },

  himalayas_jobs: {
    sourceKey: 'himalayas_jobs',
    hosts: ['himalayas.app'],
    // Offset paging, and the only one of the four that offers it. Page 2 onward is reachable, so the runner's
    // limit decides how deep to go rather than the feed's default page size.
    url: (page, limit) => `https://himalayas.app/jobs/api?limit=${Math.min(limit, 50)}&offset=${(page - 1) * Math.min(limit, 50)}`,
    parse: (body) => {
      const parsed = safeJson(body)
      const jobs = asRecordArray((parsed as { jobs?: unknown } | null)?.jobs)
      if (!jobs) return null
      return jobs.flatMap((job) => {
        const guid = toText(job.guid, 200)
        const title = toText(job.title)
        const url = toText(job.applicationLink, 500)
        if (!guid || !title || !url) return []
        return [{
          externalId: guid,
          roleTitle: title,
          companyName: toCompanyName(job.companyName),
          area: toTags(job.locationRestrictions).join(', ') || null,
          summary: toSummary(job.excerpt ?? job.description),
          postingUrl: url,
          publishedAt: toIsoDate(job.pubDate),
          remote: true,
          employmentType: toText(job.employmentType, 60),
          seniority: toTags(job.seniority)[0] ?? null,
          salaryMin: toNumber(job.minSalary),
          salaryMax: toNumber(job.maxSalary),
          salaryCurrency: toText(job.currency, 3),
          tags: toTags(job.categories),
        }]
      })
    },
  },
})

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * Builds the adapter for one feed.
 *
 * Pages until the limit is reached or the spec says there are no more. Three of the four expose a single
 * page, so paging exists for Himalayas — which reports ninety-six thousand postings and would otherwise
 * contribute only its default page however large the run's limit was.
 */
export function createJobFeedAdapter(spec: JobFeedSpec): SolutionSourceAdapter {
  return {
    sourceKey: spec.sourceKey,
    acquisitionMode: 'feed',
    requiredHosts: spec.hosts,
    metadataKeys: [
      'roleTitle', 'companyName', 'area', 'summary', 'postingUrl', 'publishedAt',
      'remote', 'employmentType', 'seniority', 'salaryMin', 'salaryMax', 'salaryCurrency', 'tags',
    ],

    async collect(context: AdapterContext): Promise<AdapterOutcome> {
      const components: AdapterComponent[] = []
      const seen = new Set<string>()
      const pageSize = Math.min(context.limit, 50)

      for (let page = 1; page <= 20; page += 1) {
        if (context.signal.aborted) break
        if (components.length >= context.limit) break

        const url = spec.url(page, pageSize)
        if (!url) break

        let response
        try {
          response = await safeFetch(url, {
            allowedHosts: context.allowedHosts,
            signal: context.signal,
            headers: { Accept: 'application/json' },
          })
        } catch (error) {
          if (error instanceof SafeFetchError) {
            if (error.code === 'rate_limited') return { kind: 'retry', reason: 'rate_limited' }
            if (error.code === 'upstream_error' || error.code === 'timeout') {
              return { kind: 'retry', reason: 'upstream_unavailable', detail: error.code }
            }
            // The safety envelope refused this URL specifically. On the first page that is the whole feed
            // and worth reporting; on a later page the earlier pages are still good data.
            if (page === 1) return { kind: 'failed', reason: error.code }
            log.warn('job_feed_page_refused', { sourceKey: spec.sourceKey, page, code: error.code })
            break
          }
          return { kind: 'failed', reason: error instanceof Error ? error.message : 'unknown' }
        }

        if (response.status === 429) return { kind: 'retry', reason: 'rate_limited' }
        if (response.status >= 500) return { kind: 'retry', reason: 'upstream_unavailable' }
        if (response.status !== 200) {
          if (page === 1) return { kind: 'failed', reason: `http_${response.status}` }
          break
        }

        const jobs = spec.parse(response.body)
        // A shape change is `failed`, not a silent empty result: an adapter that quietly returns nothing
        // when an API changes looks exactly like a source with no data, and the catalog goes stale unnoticed.
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

function toComponent(sourceKey: string, slug: string, job: FeedJob): AdapterComponent {
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
    // Empty, always. See the note at the top of this file.
    capabilities: [],
    sourceUrl: job.postingUrl,
  }
}

export const arbeitnowJobsAdapter = createJobFeedAdapter(JOB_FEEDS.arbeitnow_jobs)
export const remoteOkJobsAdapter = createJobFeedAdapter(JOB_FEEDS.remoteok_jobs)
export const jobicyJobsAdapter = createJobFeedAdapter(JOB_FEEDS.jobicy_jobs)
export const himalayasJobsAdapter = createJobFeedAdapter(JOB_FEEDS.himalayas_jobs)

export const JOB_FEED_ADAPTERS: readonly SolutionSourceAdapter[] = [
  arbeitnowJobsAdapter, remoteOkJobsAdapter, jobicyJobsAdapter, himalayasJobsAdapter,
]
