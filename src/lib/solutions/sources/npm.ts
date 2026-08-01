/**
 * npm registry package metadata via the official registry API (plan 43 Phase 4).
 *
 * `registry.npmjs.org` serves JSON by design — this is the same endpoint every package manager uses.
 * No crawl, no robots question.
 *
 * Packages enter the catalog as `tool` components. Deliberately not read: maintainer names and emails,
 * which the registry does publish. A package's maintainers are people, and a catalog of tools is not
 * where a person's contact details belong.
 */
import { safeFetch, SafeFetchError } from '~/lib/enrichment/network'
import { log } from '~/shared/lib/log'
import type { SolutionCapabilityKey } from '~/shared/lib/solutions/contracts'
import type { AdapterComponent, AdapterContext, AdapterOutcome, SolutionSourceAdapter } from './types'

const HOST = 'registry.npmjs.org'
const SEARCH_HOST = 'registry.npmjs.org'

interface NpmSearchObject {
  package?: {
    name?: unknown
    description?: unknown
    version?: unknown
    keywords?: unknown
    links?: { homepage?: unknown; npm?: unknown }
  }
}

/**
 * npm has no task taxonomy, so capabilities come from keywords — and only from an exact allowlist
 * match. A fuzzy keyword match would be an inference dressed up as a claim, and the composer treats
 * claims as facts about what a component can do.
 */
const KEYWORD_TO_CAPABILITY: Record<string, SolutionCapabilityKey> = {
  translation: 'translation',
  i18n: 'translation',
  transcription: 'transcription',
  ocr: 'document_understanding',
  'pdf-parse': 'document_understanding',
  summarization: 'summarization',
  embeddings: 'embedding',
  scraper: 'web_extraction',
  crawler: 'web_extraction',
  etl: 'data_transformation',
}

export const npmRegistryAdapter: SolutionSourceAdapter = {
  sourceKey: 'npm_registry',
  acquisitionMode: 'official_api',
  requiredHosts: [HOST, SEARCH_HOST],
  metadataKeys: ['description', 'version', 'keywords'],

  async collect(context: AdapterContext): Promise<AdapterOutcome> {
    // Bounded by the runner's limit. npm caps `size` at 250; asking for more is silently truncated,
    // so clamping here keeps the request honest about what it will get back.
    const size = Math.min(context.limit, 250)
    const url = `https://${SEARCH_HOST}/-/v1/search?text=keywords:ai,translation,ocr&size=${size}`

    let response
    try {
      response = await safeFetch(url, {
        allowedHosts: context.allowedHosts,
        signal: context.signal,
        headers: { Accept: 'application/json' },
      })
    } catch (error) {
      if (error instanceof SafeFetchError) {
        const retryable = error.code === 'rate_limited' || error.code === 'upstream_error' || error.code === 'timeout'
        return retryable
          ? { kind: 'retry', reason: error.code === 'rate_limited' ? 'rate_limited' : 'upstream_unavailable', detail: error.code }
          : { kind: 'failed', reason: error.code }
      }
      return { kind: 'failed', reason: error instanceof Error ? error.message : 'unknown' }
    }

    if (response.status === 429) return { kind: 'retry', reason: 'rate_limited' }
    if (response.status >= 500) return { kind: 'retry', reason: 'upstream_unavailable' }
    if (response.status !== 200) return { kind: 'failed', reason: `http_${response.status}` }

    let parsed: { objects?: unknown }
    try {
      parsed = JSON.parse(response.body) as { objects?: unknown }
    } catch {
      return { kind: 'failed', reason: 'invalid_json' }
    }
    if (!Array.isArray(parsed.objects)) return { kind: 'failed', reason: 'expected_objects_array' }

    const components: AdapterComponent[] = []
    for (const raw of parsed.objects) {
      // Same guard as the Hugging Face adapter: a null entry must skip, not throw and fail the batch.
      if (!raw || typeof raw !== 'object') continue
      const pkg = (raw as NpmSearchObject).package
      if (!pkg || typeof pkg.name !== 'string' || pkg.name.length === 0 || pkg.name.length > 214) continue

      const keywords = Array.isArray(pkg.keywords)
        ? pkg.keywords.filter((k): k is string => typeof k === 'string').slice(0, 20)
        : []
      const capabilityKeys = [...new Set(keywords.map((k) => KEYWORD_TO_CAPABILITY[k.toLowerCase()]).filter(Boolean))]

      components.push({
        kind: 'tool',
        slug: pkg.name,
        displayName: pkg.name,
        externalId: pkg.name,
        homepageUrl: typeof pkg.links?.npm === 'string' ? pkg.links.npm : `https://www.npmjs.com/package/${pkg.name}`,
        metadata: {
          description: typeof pkg.description === 'string' ? pkg.description.slice(0, 500) : null,
          version: typeof pkg.version === 'string' ? pkg.version : null,
          keywords,
        },
        capabilities: capabilityKeys.map((capabilityKey) => ({ capabilityKey, evidenceLevel: 'claimed' as const })),
        sourceUrl: `https://${HOST}/${pkg.name}`,
      })
    }

    log.info('solutions_adapter_collected', { sourceKey: 'npm_registry', found: components.length })
    return { kind: 'components', components }
  },
}
