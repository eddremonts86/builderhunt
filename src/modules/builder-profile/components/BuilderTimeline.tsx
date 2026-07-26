import * as React from 'react'
import { Clock, GitBranch, GitPullRequest, Rocket, FileText, MessageCircle, MessageSquare, ExternalLink, History } from 'lucide-react'
import { ai } from '~/shared/lib/ai/client'
import { AIUnavailableError } from '~/shared/lib/ai/errors'
import { Button } from '~/components/ui'
import type { TimelineEvent, TimelineEventType, TimelineResult } from '~/lib/timeline/types'

interface BuilderTimelineProps {
  builderId: string
  source: string
}

type FilterKey = 'all' | 'code' | 'writing' | 'qa'

const FILTERS: Array<{ key: FilterKey; label: string; types: TimelineEventType[] | null }> = [
  { key: 'all', label: 'All', types: null },
  { key: 'code', label: 'Code', types: ['repo', 'release', 'pr'] },
  { key: 'writing', label: 'Writing', types: ['article', 'post'] },
  { key: 'qa', label: 'Q&A', types: ['answer', 'comment'] },
]

const TYPE_ICON: Record<TimelineEventType, React.ComponentType<{ className?: string }>> = {
  repo: GitBranch,
  release: Rocket,
  pr: GitPullRequest,
  post: FileText,
  article: FileText,
  answer: MessageSquare,
  comment: MessageCircle,
}

function formatRelativeTime(iso: string): string {
  const ms = Date.parse(iso)
  if (isNaN(ms)) return ''
  const diff = Date.now() - ms
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'today'
  if (diff < 30 * day) return `${Math.max(1, Math.floor(diff / day))}d ago`
  return `${Math.floor(diff / (30 * day))}mo ago`
}

export function BuilderTimeline({ builderId, source }: BuilderTimelineProps) {
  const [result, setResult] = React.useState<TimelineResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [filter, setFilter] = React.useState<FilterKey>('all')
  const [summary, setSummary] = React.useState<string | null>(null)
  const [summarizing, setSummarizing] = React.useState(false)
  const [summaryUnavailable, setSummaryUnavailable] = React.useState(false)

  // Fetched after the profile's own paint — never blocks the rest of the page.
  React.useEffect(() => {
    let cancelled = false
    fetch(`/api/builders/${builderId}/timeline`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: TimelineResult | null) => { if (!cancelled) setResult(data) })
      .catch(() => { if (!cancelled) setResult(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [builderId])

  const filtered = React.useMemo(() => {
    if (!result) return []
    const active = FILTERS.find((f) => f.key === filter)
    if (!active?.types) return result.events
    return result.events.filter((e) => active.types!.includes(e.type))
  }, [result, filter])

  const handleSummarize = async () => {
    if (!result || result.events.length === 0) return
    setSummarizing(true)
    try {
      const { output } = await ai<{ summary: string }>('timeline-summary', {
        events: result.events.slice(0, 20).map((e) => ({ type: e.type, title: e.title, timestamp: e.timestamp })),
      })
      setSummary(output.summary)
    } catch (err) {
      if (err instanceof AIUnavailableError) setSummaryUnavailable(true)
    } finally {
      setSummarizing(false)
    }
  }

  if (loading) {
    return (
      <div className="card rounded-3xl bg-bh-surface border-bh-border shadow-sm p-6 min-h-[220px]" data-testid="builder-timeline">
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-32 bg-bh-bg-alt rounded" />
          <div className="h-12 bg-bh-bg-alt rounded" />
          <div className="h-12 bg-bh-bg-alt rounded" />
          <div className="h-12 bg-bh-bg-alt rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="card rounded-3xl bg-bh-surface border-bh-border shadow-sm p-6" data-testid="builder-timeline">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 className="text-base font-semibold text-bh-text flex items-center gap-2">
          <History className="w-4 h-4" aria-hidden="true" />
          Recent activity
        </h3>
        {!summaryUnavailable && result?.supported && result.events.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={handleSummarize} disabled={summarizing}>
            {summarizing ? 'Summarizing…' : 'Summarize activity'}
          </Button>
        )}
      </div>

      {summary && (
        <p className="text-sm text-bh-text-muted mb-4 p-3 rounded-lg bg-bh-bg-alt border border-bh-border" role="status">
          {summary}
        </p>
      )}

      {!result?.supported ? (
        <p className="text-sm text-bh-text-dim">Activity timeline isn't available for {source} profiles.</p>
      ) : result.events.length === 0 ? (
        <p className="text-sm text-bh-text-dim">No public activity in the last year.</p>
      ) : (
        <>
          <div className="flex gap-1.5 mb-4 flex-wrap" role="tablist" aria-label="Filter activity">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  filter === f.key
                    ? 'bg-bh-accent-soft border-bh-accent text-bh-text'
                    : 'border-bh-border text-bh-text-muted hover:border-bh-border-strong'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <ul className="space-y-3" role="list">
            {filtered.map((event) => (
              <TimelineRow key={event.id} event={event} />
            ))}
            {filtered.length === 0 && (
              <li className="text-sm text-bh-text-dim">No activity in this category.</li>
            )}
          </ul>
        </>
      )}
    </div>
  )
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const Icon = TYPE_ICON[event.type]
  return (
    <li className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-bh-accent-soft flex items-center justify-center shrink-0 text-bh-accent">
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-bh-text hover:text-bh-accent inline-flex items-center gap-1 break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded"
        >
          {event.title}
          <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
        </a>
        {event.description && (
          <p className="text-xs text-bh-text-muted mt-0.5 line-clamp-2 break-words">{event.description}</p>
        )}
        <p className="text-xs text-bh-text-dim mt-1 inline-flex items-center gap-1">
          <Clock className="w-3 h-3" aria-hidden="true" />
          {formatRelativeTime(event.timestamp)}
        </p>
      </div>
    </li>
  )
}
