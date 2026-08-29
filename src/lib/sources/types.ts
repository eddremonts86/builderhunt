/**
 * What a search result actually is.
 *
 * `organization` was added after 30 of 60 GitHub results turned out to be repositories and one of the
 * "people" was a company account. A recruiter searching for people must not be shown either, and merging
 * either into a canonical human is not a subtle error.
 */
export type BuilderKind = 'person' | 'repo' | 'organization'

export type SourceName =
  | 'github'
  | 'gitlab'
  | 'codeberg'
  | 'sourcehut'
  | 'hn'
  | 'reddit'
  | 'devto'
  | 'hashnode'
  | 'stackoverflow'
  | 'npm'
  | 'huggingface'
  | 'lobsters'
  | 'devpost'
  | 'producthunt'
  | 'bluesky'

export const SOURCE_NAMES = [
  'github',
  'gitlab',
  'codeberg',
  'sourcehut',
  'hn',
  'reddit',
  'devto',
  'hashnode',
  'stackoverflow',
  'npm',
  'huggingface',
  'lobsters',
  'devpost',
  'producthunt',
  'bluesky',
] as const satisfies readonly SourceName[]

/**
 * Origins that produce builders without contacting anybody.
 *
 * Kept out of `SourceName` on purpose. Every registry keyed on that union describes a *network
 * connector*: the operator's source register decides whether it may be contacted, `CREDENTIAL_*`
 * says which token it needs, the discovery matrix schedules crawls against it, and the acquisition
 * policy records what its terms of service permit. A self-managed profile is a row this product
 * owns, declared by its owner — it has no terms, no credential, no host to be down. Adding it to
 * `SourceName` would make every one of those registries answer a question that does not apply, and
 * the honest answers ("no credential", "always enabled", "never crawled") are indistinguishable
 * from a connector somebody forgot to configure.
 *
 * A separate union costs one widened field and buys a compiler error at every place that assumed a
 * builder's origin is reachable over HTTP — which is exactly where the assumption needed checking.
 */
export const INTERNAL_ORIGIN_NAMES = ['self-managed'] as const
export type InternalOriginName = (typeof INTERNAL_ORIGIN_NAMES)[number]

/** Where a builder came from: a network connector, or one of this product's own origins. */
export type BuilderOrigin = SourceName | InternalOriginName

export function isInternalOrigin(origin: string): origin is InternalOriginName {
  return (INTERNAL_ORIGIN_NAMES as readonly string[]).includes(origin)
}

export interface RawBuilder {
  id: string
  kind: BuilderKind
  source: BuilderOrigin
  sourceId: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  country?: string
  topics: string[]
  metadata: Record<string, unknown>
}
