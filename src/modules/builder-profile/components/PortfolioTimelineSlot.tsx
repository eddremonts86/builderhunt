import * as React from 'react'
import { Clock, History, Wand2 } from 'lucide-react'
import { Button } from '~/components/ui'
import { ai } from '~/shared/lib/ai/client'
import { AIUnavailableError } from '~/shared/lib/ai/errors'
import { useAICapabilities } from '~/shared/lib/ai/useAICapabilities'
import type { PortfolioTimelineEvent } from '~/shared/lib/portfolio-integrations'

interface PortfolioTimelineSlotProps {
  events: PortfolioTimelineEvent[]
  /** The "Summarize activity" action is owner-only — a public visitor never triggers an AI call. */
  isOwner: boolean
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * plans/UI/tasks.md Wave 7 "Add opt-in public timeline to portfolios" — a read-only, bounded,
 * already-allowlisted event list (see `readTimelineForPortfolio`). Unlike `BuilderTimeline.tsx`'s
 * reactive try/catch gating, the summarize button here is pre-gated on `useAICapabilities()` since
 * it's owner-only chrome on an otherwise fully public page — no point showing a button that can
 * only ever fail for every anonymous visitor.
 */
export function PortfolioTimelineSlot({ events, isOwner }: PortfolioTimelineSlotProps) {
  const { ready, serverAI, disabled } = useAICapabilities()
  const [summary, setSummary] = React.useState<string | null>(null)
  const [summarizing, setSummarizing] = React.useState(false)

  if (events.length === 0) return null

  const canSummarize = isOwner && !disabled && (ready || serverAI)

  const handleSummarize = async () => {
    setSummarizing(true)
    try {
      const { output } = await ai<{ summary: string }>('timeline-summary', {
        events: events.map((event) => ({ type: event.kind, title: event.title, timestamp: event.occurredAt })),
      })
      setSummary(output.summary)
    } catch (err) {
      if (!(err instanceof AIUnavailableError)) throw err
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <section className="card rounded-3xl p-6 mb-6" aria-labelledby="portfolio-timeline-heading" data-testid="portfolio-timeline">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 id="portfolio-timeline-heading" className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim flex items-center gap-2">
          <History className="w-4 h-4 text-bh-accent" aria-hidden="true" />
          Recent activity
        </h2>
        {canSummarize && (
          <Button type="button" variant="ghost" size="sm" onClick={handleSummarize} disabled={summarizing} data-testid="portfolio-timeline-summarize">
            <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
            {summarizing ? 'Summarizing…' : 'Summarize activity'}
          </Button>
        )}
      </div>

      {summary && (
        <p className="text-sm text-bh-text-muted mb-4 p-3 rounded-lg bg-bh-bg-alt border border-bh-border" role="status">
          {summary}
        </p>
      )}

      <ul className="space-y-3" role="list">
        {events.map((event) => (
          <li key={event.id} className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-bh-accent-soft flex items-center justify-center shrink-0 text-bh-accent">
              <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-bh-text break-words">{event.title}</p>
              {event.summary && (
                <p className="text-xs text-bh-text-muted mt-0.5 line-clamp-2 break-words">{event.summary}</p>
              )}
              <p className="text-xs text-bh-text-dim mt-1">{formatDate(event.occurredAt)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
