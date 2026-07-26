import type { SourceName } from '~/lib/sources/types'

export type TimelineEventType =
  | 'repo'
  | 'release'
  | 'pr'
  | 'post'
  | 'article'
  | 'answer'
  | 'comment'

export interface TimelineEvent {
  id: string
  type: TimelineEventType
  source: SourceName
  title: string
  description?: string
  url: string
  timestamp: string
}

export interface TimelineResult {
  events: TimelineEvent[]
  source: SourceName
  supported: boolean
  fetchedAt: string
}
