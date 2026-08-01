/**
 * Jobindex open roles, via the RSS feed Jobindex publishes itself.
 *
 * `https://www.jobindex.dk/jobsoegning.rss?q=<query>` returns RSS with `ttl=1440`. A publisher offering
 * RSS is offering it for machine consumption, so this is a `feed` and not a crawl: no robots question,
 * no HTML page fetched that the site did not hand over for this purpose. The declared 24h ttl is the
 * register's `refresh_interval_hours`, honoured rather than noted.
 *
 * **What this contributes, and what it does not.** A job posting is an employer describing a role it
 * wants filled. That makes it demand-side market signal — which roles Danish employers are hiring for,
 * in which areas — and it enters the catalog as `human_role` components. It is *not* candidate data:
 * nothing here is about a person, and no contact name, recruiter, or applicant detail is read even when
 * the posting body contains one. That is why this source is registered in `solution_sources` and
 * deliberately not in `search_sources` alongside the people-search connectors.
 *
 * **No capability claims, ever.** A job ad states what an employer wants; it says nothing about what
 * anyone can do. Attaching capabilities from a wish list would let the composer treat "someone in
 * Denmark advertised for a Rust developer" as evidence that a Rust developer exists and is available.
 *
 * The feed is ISO-8859-1, which matters: Danish job titles are full of æ/ø/å and decoding the bytes as
 * UTF-8 turns "Systemudvikling i København" into mojibake that then becomes a permanent component slug.
 *
 * **What the feed actually returns**, measured against it on 2026-08-01 rather than assumed:
 *
 * - 20 items per query. The `q` parameter is applied — `q=developer` and `q=designer` overlapped on
 *   only 5 of 20 postings — so the query list below is doing real work.
 * - Every item was a promoted listing (`class="PaidJob"` in the description body). This feed is
 *   Jobindex's paid-placement inventory, not its full index.
 * - Relevance is loose: `q=developer` returned "Packaging Technical Assistant".
 *
 * The consequence is a bound on how the composer may read these components: they are evidence that
 * *someone in Denmark is advertising this role*, not a representative sample of Danish hiring demand.
 * Getting a precise, complete index would mean fetching the `/jobsoegning?q=` HTML pages, which is a
 * scrape and needs the recorded terms review that `search_sources_scrape_needs_review_check` demands.
 */
import { safeFetch, SafeFetchError } from '~/lib/enrichment/network'
import { log } from '~/shared/lib/log'
import type { AdapterComponent, AdapterContext, AdapterOutcome, SolutionSourceAdapter } from './types'

const HOST = 'www.jobindex.dk'

/**
 * Queries the feed is asked for, one request each.
 *
 * A fixed list rather than a free-text parameter: the register's rate limit is per hour, and a caller
 * able to pass arbitrary queries could turn one run into hundreds of requests. Widening the catalog's
 * coverage of Danish roles is a change to this constant, which is reviewable.
 */
const FEED_QUERIES = [
  'developer', 'software engineer', 'data engineer', 'machine learning',
  'devops', 'designer', 'product manager',
] as const

export const jobindexRolesAdapter: SolutionSourceAdapter = {
  sourceKey: 'jobindex_roles',
  acquisitionMode: 'feed',
  requiredHosts: [HOST],
  // `matchedQuery` is deliberately absent: it describes our own query rather than the posting, so it
  // belongs in a log and has no business in the catalog. The runner drops it, and that is intended.
  metadataKeys: ['roleTitle', 'companyName', 'area', 'summary', 'postingUrl', 'publishedAt'],

  async collect(context: AdapterContext): Promise<AdapterOutcome> {
    const components: AdapterComponent[] = []
    // Keyed by slug so the same posting appearing under two queries — common, since "developer" and
    // "software engineer" overlap heavily — yields one component rather than two ingestion attempts
    // racing on the same unique index.
    const seen = new Set<string>()

    for (const query of FEED_QUERIES) {
      if (context.signal.aborted) break
      if (components.length >= context.limit) break

      const url = `https://${HOST}/jobsoegning.rss?q=${encodeURIComponent(query)}`
      let response
      try {
        response = await safeFetch(url, {
          allowedHosts: context.allowedHosts,
          signal: context.signal,
          headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
          // `safeFetch`'s default allowlist is JSON/HTML/plain text; a feed is none of those. Opted in
          // here rather than added globally so no other connector starts accepting XML.
          additionalContentTypes: ['application/rss+xml', 'application/xml', 'text/xml'],
          // Jobindex declares ISO-8859-1 in the XML prolog and sends no charset in the header, so
          // without this every æ/ø/å in a Danish job title decodes to a replacement character.
          fallbackCharset: 'iso-8859-1',
        })
      } catch (error) {
        if (error instanceof SafeFetchError) {
          // Rate limiting and upstream trouble are the whole feed's problem, not this query's: coming
          // back later is the right move, and continuing would just burn the remaining requests.
          if (error.code === 'rate_limited') return { kind: 'retry', reason: 'rate_limited' }
          if (error.code === 'upstream_error' || error.code === 'timeout') {
            return { kind: 'retry', reason: 'upstream_unavailable', detail: error.code }
          }
          // A refusal from the safety envelope (unexpected host, private address, bad content type) is
          // specific to this URL. Log and try the next query rather than discard the whole run.
          log.warn('jobindex_feed_refused', { query, code: error.code })
          continue
        }
        continue
      }

      if (response.status === 429) return { kind: 'retry', reason: 'rate_limited' }
      if (response.status >= 500) return { kind: 'retry', reason: 'upstream_unavailable' }
      if (response.status !== 200) continue

      for (const item of parseRssItems(response.body)) {
        if (components.length >= context.limit) break
        const component = itemToComponent(item, query)
        if (!component || seen.has(component.slug)) continue
        seen.add(component.slug)
        components.push(component)
      }
    }

    log.info('solutions_adapter_collected', { sourceKey: 'jobindex_roles', found: components.length })
    return { kind: 'components', components }
  },
}

interface RssItem {
  title: string
  link: string
  pubDate: string | null
  description: string | null
}

/**
 * Pulls `<item>` blocks out of the feed with a regex rather than an XML parser.
 *
 * The same reasoning as the documentation crawler's title/description extraction: a bounded reader over
 * four named fields makes "what can this source contribute" a question about this function. A general
 * XML parser would also mean handling entity expansion on remote input, which is a class of problem
 * (billion laughs, external entities) worth not having.
 *
 * Capped at 200 items per feed. Jobindex returns 20 by default; the cap is the backstop for a feed that
 * one day returns thousands, so a single response cannot drive unbounded work.
 */
function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = []
  const itemPattern = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(xml)) !== null && items.length < 200) {
    const block = match[1]
    const title = tag(block, 'title')
    const link = tag(block, 'link')
    if (!title || !link) continue
    items.push({ title, link, pubDate: tag(block, 'pubDate'), description: tag(block, 'description') })
  }
  return items
}

function tag(block: string, name: string): string | null {
  const pattern = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i')
  const found = pattern.exec(block)?.[1]
  if (found === undefined) return null
  const value = decodeEntities(stripCdata(found)).trim()
  return value.length > 0 ? value : null
}

function stripCdata(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value)
  return cdata ? cdata[1] : value
}

/**
 * Decodes the numeric and named entities this feed actually emits. Jobindex escapes its descriptions
 * twice (the HTML body arrives as `&#x3C;div ...`), so numeric forms dominate and have to be handled.
 * `&amp;` is decoded last, otherwise `&amp;#x3C;` would become `<` instead of the literal `&#x3C;`.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** An out-of-range code point would throw and take the whole feed down over one bad escape. */
function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Turns one posting into a `human_role` component.
 *
 * Jobindex titles are `"<role>, <company>"`. Splitting on the last comma is right more often than the
 * first: role titles contain commas ("Senior Developer, Backend, Nordea") while company names rarely
 * do. When there is no comma at all the whole title is the role and the company is simply unknown —
 * recorded as null rather than guessed, because a wrong employer name is worse than a missing one.
 */
function itemToComponent(item: RssItem, query: string): AdapterComponent | null {
  // The posting id in /vis-job/<id> is the only stable identifier the feed offers. Without it a
  // reworded title would mint a second component for the same posting on the next refresh.
  const postingId = /\/vis-job\/([A-Za-z0-9_-]{1,64})/.exec(item.link)?.[1]
  if (!postingId) return null

  const lastComma = item.title.lastIndexOf(',')
  const roleTitle = (lastComma > 0 ? item.title.slice(0, lastComma) : item.title).trim().slice(0, 200)
  const companyName = lastComma > 0 ? item.title.slice(lastComma + 1).trim().slice(0, 200) || null : null
  if (roleTitle.length === 0) return null

  const publishedAt = item.pubDate ? Date.parse(item.pubDate) : Number.NaN

  return {
    kind: 'human_role',
    slug: `jobindex-${postingId}`,
    displayName: roleTitle,
    externalId: postingId,
    homepageUrl: item.link,
    metadata: {
      roleTitle,
      companyName,
      area: extractArea(item.description),
      summary: extractSummary(item.description),
      postingUrl: item.link,
      publishedAt: Number.isNaN(publishedAt) ? null : new Date(publishedAt).toISOString(),
      // Which feed query surfaced this posting. Kept out of `allowed_fields` on purpose: it describes
      // our own query, not the posting, so it is useful in a log and has no business in the catalog.
      matchedQuery: query,
    },
    // Empty, always. See the note at the top of this file.
    capabilities: [],
    sourceUrl: item.link,
  }
}

/** Jobindex marks the work area with a known class in the escaped description body. */
function extractArea(description: string | null): string | null {
  if (!description) return null
  const area = /<span[^>]*class="[^"]*jix_robotjob--area[^"]*"[^>]*>([^<]{1,120})<\/span>/i.exec(description)?.[1]
  return area ? area.trim() : null
}

/** The first paragraph of the ad, stripped of markup and hard-capped. Never the whole body. */
function extractSummary(description: string | null): string | null {
  if (!description) return null
  const paragraph = /<p[^>]*>([\s\S]{1,2000}?)<\/p>/i.exec(description)?.[1]
  if (!paragraph) return null
  const text = paragraph.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text.slice(0, 500) : null
}
