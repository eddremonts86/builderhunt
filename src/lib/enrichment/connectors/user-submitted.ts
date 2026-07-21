/**
 * User-submitted URL adapter (spec §4, §8). Never fetches — only normalizes
 * and stores the submitted link as attributed evidence. This is what lets a
 * LinkedIn/X/Meta URL be recorded (spec §5.3) without ever making an
 * outbound request to a blocked host.
 */

import type { ConnectorResult, EnrichmentConnector, EnrichmentTarget } from '../types'
import { getSourcePolicy } from '../policies'
import { normalizeUrl } from '../normalize'

const policy = getSourcePolicy('user-submitted')
if (!policy) throw new Error('user-submitted connector loaded without a source policy')

export const userSubmittedConnector: EnrichmentConnector = {
  id: 'user-submitted',
  policy,
  supports(target: EnrichmentTarget): boolean {
    return target.submittedUrls.length > 0
  },
  async collect(target: EnrichmentTarget): Promise<ConnectorResult> {
    const candidates = target.submittedUrls
      .map(normalizeUrl)
      .filter(Boolean)
      .map((url) => ({
        connector: 'user-submitted' as const,
        acquisitionMode: 'user_submitted' as const,
        sourceUrl: url,
        payload: { profileUrl: url, topics: [] as string[] },
        observedAt: new Date(),
      }))
    if (candidates.length === 0) return { kind: 'no_data' }
    return { kind: 'evidence', candidates }
  },
}
