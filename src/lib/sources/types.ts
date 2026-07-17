export type BuilderKind = 'person' | 'repo'

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
