/**
 * Public Profile Enrichment — connector registry.
 * Spec reference: plans/implemented/42-stealth-scraping/spec.md §4, §8; tasks.md Phase 3.
 * Returns only connectors that are both compile-time enabled AND present in
 * the runtime allowlist — the one place the worker/routes ask "what can run".
 */

import type { EnrichmentConnector } from './types'
import { resolveExecutableConnectorIds } from './policies'
import { githubConnector } from './connectors/github'
import { userSubmittedConnector } from './connectors/user-submitted'

const ALL_CONNECTORS: Readonly<Record<string, EnrichmentConnector>> = Object.freeze({
  github: githubConnector,
  'user-submitted': userSubmittedConnector,
})

/** user-submitted never needs a runtime allowlist entry — it makes no network call. */
const ALWAYS_AVAILABLE_CONNECTOR_IDS = ['user-submitted']

export function getExecutableConnectors(
  allowlistEnv: string | undefined,
  requestedIds: readonly string[],
): EnrichmentConnector[] {
  const executable = new Set([
    ...resolveExecutableConnectorIds(allowlistEnv),
    ...ALWAYS_AVAILABLE_CONNECTOR_IDS,
  ])
  const requested = new Set(requestedIds.map((id) => id.trim().toLowerCase()))
  return Object.values(ALL_CONNECTORS).filter(
    (connector) => executable.has(connector.id) && requested.has(connector.id),
  )
}

export function getRegisteredConnectorIds(): string[] {
  return Object.keys(ALL_CONNECTORS)
}
