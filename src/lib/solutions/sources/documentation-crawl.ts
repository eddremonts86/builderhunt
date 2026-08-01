/**
 * Compliant public documentation crawl (plan 43 Phase 4, "Extend compliant public crawl/scrape
 * ingestion").
 *
 * **No real source is registered for this adapter.** It is a mechanism, not a decision about whose
 * site to fetch. Choosing crawl targets requires reading terms of service, checking robots.txt and
 * judging whether personal data is involved — a human review recorded in
 * `plans/phase-5/01-production-readiness-audit`, and the database will not let a `public_scrape`
 * source be enabled without it (`solution_sources_scrape_needs_review_check`). Until an operator
 * registers a reviewed source and enables it, this adapter is unreachable code by design.
 *
 * It reuses plan 42's enrichment protections rather than reimplementing them, which is what spec.md
 * means by "Extend the current enrichment registry ... instead of creating a second crawler":
 *
 * - `safeFetch` — HTTPS-only, exact-host allowlist, public-IP-only DNS (so no SSRF into the private
 *   network), redirect revalidation, timeout, byte cap, content-type allowlist.
 * - `isPathAllowedByRobots` — honest user agent, and **`unavailable` is treated as disallowed here**.
 *   The enrichment path can afford to proceed when robots.txt cannot be read; a catalog crawl cannot,
 *   because "we could not check whether we were allowed" is not permission.
 *
 * Nothing about people is extracted. A documentation page's author byline is skipped on purpose: this
 * adapter builds a catalog of tools and services, and a person who happens to have written the docs
 * has not asked to be in it.
 */
import { isPathAllowedByRobots } from '~/lib/enrichment/robots'
import { ENRICHMENT_DEFAULT_USER_AGENT, safeFetch, SafeFetchError } from '~/lib/enrichment/network'
import { log } from '~/shared/lib/log'
import type { AdapterComponent, AdapterContext, AdapterOutcome, SolutionSourceAdapter } from './types'

export interface DocumentationCrawlTarget {
  /** Must match a `solution_sources.key` whose kind is `public_scrape` and which an operator enabled. */
  sourceKey: string
  /** Exact host. `safeFetch` enforces it; this is not a prefix match. */
  host: string
  /** Absolute paths to fetch. Enumerated, never discovered by following links — a crawler that
   * follows links goes places nobody reviewed. */
  paths: readonly string[]
  /** What kind of component each page describes. */
  componentKind: 'tool' | 'service' | 'mcp_server' | 'agent'
  /** Capability keys this target is permitted to claim, from its register entry. A page cannot
   * introduce a capability the review did not anticipate. */
  allowedCapabilityKeys: readonly string[]
}

/**
 * Builds an adapter for one reviewed crawl target.
 *
 * A factory rather than a hardcoded adapter because the target list is operator data, not source code
 * — the whole point is that adding a crawl target is a register entry plus a recorded review, not a
 * deploy.
 */
export function createDocumentationCrawlAdapter(target: DocumentationCrawlTarget): SolutionSourceAdapter {
  return {
    sourceKey: target.sourceKey,
    acquisitionMode: 'public_scrape',
    requiredHosts: [target.host],
    metadataKeys: ['summary', 'crawledPath'],

    async collect(context: AdapterContext): Promise<AdapterOutcome> {
      const origin = `https://${target.host}`
      const components: AdapterComponent[] = []
      let robotsBlocked = 0

      for (const path of target.paths.slice(0, context.limit)) {
        if (context.signal.aborted) break

        // Asked per path, not once per host: robots.txt can allow /docs and forbid /internal, and a
        // single host-level check would miss that.
        const decision = await isPathAllowedByRobots(origin, path, ENRICHMENT_DEFAULT_USER_AGENT)
        if (decision !== 'allowed') {
          // `unavailable` lands here too. Not being able to read robots.txt is not permission.
          robotsBlocked += 1
          log.warn('solutions_crawl_robots_blocked', { sourceKey: target.sourceKey, path, decision })
          continue
        }

        let response
        try {
          response = await safeFetch(`${origin}${path}`, {
            allowedHosts: context.allowedHosts,
            signal: context.signal,
            userAgent: ENRICHMENT_DEFAULT_USER_AGENT,
          })
        } catch (error) {
          if (error instanceof SafeFetchError) {
            if (error.code === 'rate_limited') return { kind: 'retry', reason: 'rate_limited' }
            if (error.code === 'upstream_error' || error.code === 'timeout') {
              return { kind: 'retry', reason: 'upstream_unavailable', detail: error.code }
            }
            // private_network, host_not_allowed, auth_required, redirect_denied: the safety envelope
            // refused. Skip this page and keep going; one bad path does not condemn the target.
            log.warn('solutions_crawl_fetch_refused', { sourceKey: target.sourceKey, path, code: error.code })
            continue
          }
          continue
        }

        if (response.status !== 200) continue

        const extracted = extractComponent(response.body, {
          target,
          path,
          finalUrl: response.finalUrl,
        })
        if (extracted) components.push(extracted)
      }

      log.info('solutions_adapter_collected', {
        sourceKey: target.sourceKey,
        found: components.length,
        robotsBlocked,
      })
      return { kind: 'components', components }
    },
  }
}

/**
 * Pulls a title and a short summary out of a documentation page.
 *
 * Regex on `<title>` and `<meta name="description">` rather than a DOM parse: those two tags are what
 * a documentation site publishes *for* this purpose, and restricting extraction to them is a hard
 * bound on what a crawl can ever store. A general HTML parser would make "what did we take from that
 * page" a question about the page's markup instead of about this function.
 *
 * Returns null when neither is present. An untitled page yields no component rather than a placeholder
 * one — a catalog entry called "Untitled" is worse than an absent entry.
 */
function extractComponent(
  html: string,
  context: { target: DocumentationCrawlTarget; path: string; finalUrl: string },
): AdapterComponent | null {
  const title = matchOne(html, /<title[^>]*>([^<]{1,200})<\/title>/i)
  const description = matchOne(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i)
  if (!title) return null

  const slug = `${context.target.host}${context.path}`.replace(/[^a-zA-Z0-9._/-]/g, '-').slice(0, 200)

  return {
    kind: context.target.componentKind,
    slug,
    displayName: decodeBasicEntities(title).trim().slice(0, 200),
    externalId: slug,
    homepageUrl: context.finalUrl,
    metadata: {
      summary: description ? decodeBasicEntities(description).trim().slice(0, 500) : null,
      crawledPath: context.path,
    },
    // A crawled page is the weakest evidence there is — a vendor describing itself in prose. It never
    // yields a capability claim at all, because "the docs mention translation" is not the same as
    // "this tool translates". Capabilities for crawled components come from a reviewer.
    capabilities: [],
    sourceUrl: context.finalUrl,
  }
}

function matchOne(input: string, pattern: RegExp): string | null {
  const match = pattern.exec(input)
  return match?.[1] ?? null
}

/** The five entities that actually show up in titles. Not a general decoder — a general one invites
 * feeding it arbitrary markup, which is the opposite of the bound above. */
function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
