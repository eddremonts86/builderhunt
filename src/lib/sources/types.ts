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

export interface RawBuilder {
  id: string
  kind: BuilderKind
  source: SourceName
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
