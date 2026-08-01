/**
 * Hugging Face model metadata via the official HTTP API (plan 43 Phase 4).
 *
 * Official API, not a crawl: `https://huggingface.co/api/models` is a documented public endpoint that
 * returns JSON. No HTML parsing, no robots question, nothing fetched that the endpoint does not
 * publish for this purpose.
 *
 * Only the model card's own declared fields are read. Deliberately NOT read: anything about the
 * author as a person. A model's owner is a human whose profile is not what this catalog is for, and
 * `builder_identities` is where people live.
 */
import { safeFetch, SafeFetchError } from '~/lib/enrichment/network'
import { log } from '~/shared/lib/log'
import type { SolutionCapabilityKey } from '~/shared/lib/solutions/contracts'
import type { AdapterContext, AdapterOutcome, SolutionSourceAdapter } from './types'

const HOST = 'huggingface.co'

interface HuggingFaceModel {
  id?: unknown
  pipeline_tag?: unknown
  library_name?: unknown
  downloads?: unknown
  likes?: unknown
  tags?: unknown
}

/**
 * `pipeline_tag` is Hugging Face's own task label. Mapping it to our capability vocabulary is a
 * lookup, never an inference: an unmapped tag yields no capability claim rather than a guessed one,
 * because a wrong capability claim is what makes the composer recommend a model for work it cannot do.
 */
const PIPELINE_TO_CAPABILITY: Record<string, SolutionCapabilityKey> = {
  translation: 'translation',
  summarization: 'summarization',
  'automatic-speech-recognition': 'transcription',
  'text-generation': 'text_generation',
  'text2text-generation': 'text_generation',
  'feature-extraction': 'embedding',
  'sentence-similarity': 'embedding',
  'token-classification': 'entity_extraction',
  'text-classification': 'classification',
  'zero-shot-classification': 'classification',
  'image-to-text': 'image_understanding',
  'document-question-answering': 'document_understanding',
}

export const huggingFaceModelsAdapter: SolutionSourceAdapter = {
  sourceKey: 'huggingface_models',
  acquisitionMode: 'official_api',
  requiredHosts: [HOST],
  metadataKeys: ['pipelineTag', 'libraryName', 'downloads', 'likes', 'tags'],

  async collect(context: AdapterContext): Promise<AdapterOutcome> {
    const url = `https://${HOST}/api/models?sort=downloads&direction=-1&limit=${context.limit}&full=false`

    let response
    try {
      response = await safeFetch(url, {
        allowedHosts: context.allowedHosts,
        signal: context.signal,
        headers: { Accept: 'application/json' },
      })
    } catch (error) {
      if (error instanceof SafeFetchError) {
        // 429 and 5xx are the upstream asking us to come back; everything else is ours to fix.
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

    let parsed: unknown
    try {
      parsed = JSON.parse(response.body)
    } catch {
      return { kind: 'failed', reason: 'invalid_json' }
    }
    // A shape change is a `failed`, not a silent empty result: an adapter that quietly returns nothing
    // when the API changes looks identical to a source with no data, and the catalog would just go
    // stale without anyone noticing.
    if (!Array.isArray(parsed)) return { kind: 'failed', reason: 'expected_array' }

    const components = parsed.flatMap((raw) => {
      // `raw` can be null or a primitive: the endpoint is public and its array is not guaranteed
      // homogeneous. Casting first and reading `.id` throws on null, which would turn one bad entry
      // into a failed batch.
      if (!raw || typeof raw !== 'object') return []
      const model = raw as HuggingFaceModel
      if (typeof model.id !== 'string' || model.id.length === 0 || model.id.length > 200) return []

      const pipelineTag = typeof model.pipeline_tag === 'string' ? model.pipeline_tag : null
      const capabilityKey = pipelineTag ? PIPELINE_TO_CAPABILITY[pipelineTag] : undefined

      return [{
        kind: 'model' as const,
        slug: model.id,
        displayName: model.id.split('/').pop() ?? model.id,
        externalId: model.id,
        homepageUrl: `https://${HOST}/${model.id}`,
        metadata: {
          pipelineTag,
          libraryName: typeof model.library_name === 'string' ? model.library_name : null,
          downloads: typeof model.downloads === 'number' ? model.downloads : null,
          likes: typeof model.likes === 'number' ? model.likes : null,
          tags: Array.isArray(model.tags) ? model.tags.filter((t): t is string => typeof t === 'string').slice(0, 20) : [],
        },
        // `claimed`, never higher. This is the vendor's own label, which is a claim and not a
        // measurement — promoting it would let the UI present a self-description as verified.
        capabilities: capabilityKey ? [{ capabilityKey, evidenceLevel: 'claimed' as const }] : [],
        sourceUrl: `https://${HOST}/api/models/${model.id}`,
      }]
    })

    log.info('solutions_adapter_collected', { sourceKey: 'huggingface_models', found: components.length })
    return { kind: 'components', components }
  },
}
