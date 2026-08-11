import * as React from 'react'
import { CalendarClock } from 'lucide-react'
import { MetricCard, MetricSectionView } from '../MetricSectionView'
import type { SectionWidgetProps } from '../MetricSectionView'

/**
 * Feature reliability (plan 57, Admin track — "Build Feature Reliability metrics with interview signals
 * first").
 *
 * The task says interview signals first, and the reason is that they are the only per-feature reliability
 * numbers that already exist. Everything else a reliability section would want — per-feature availability
 * samples over a window — has no store, which is why the contract section stays `insufficient_history` rather
 * than showing a 100 % uptime figure derived from nothing.
 *
 * ## The two rules this panel obeys, inherited from the counters it renders
 *
 * 1. **Never show a number as a fact when the door it counts is shut.** The capability grid comes first and the
 *    counters are *absent* — not zero — while everything is off. The API enforces the same thing by omitting
 *    `counters`, so this is not the only guard.
 * 2. **Nothing but numbers.** Every value is a counter and every label is static text. That is what makes an
 *    interview dashboard safe to look at: a candidate's name, filename, transcript line or capability secret
 *    has no path into this component, because it never receives one.
 *
 * The counters are grouped by the question an operator is actually asking rather than in declaration order —
 * "is intake working", "is capture working", "is the AI behaving", "is retention keeping up". An alphabetical
 * list of nineteen numbers is a list, not a dashboard.
 */

interface InterviewOperations {
  capabilities: {
    calendar: boolean
    scheduling: boolean
    candidateUploads: boolean
    transcription: boolean
    sensitiveAi: boolean
  }
  counters?: Record<string, number>
}

const INTERVIEW_COUNTER_GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Scheduling and intake',
    keys: [
      ['bookingConflicts', 'Booking conflicts'],
      ['staleReservations', 'Stale reservations'],
      ['schedulesStale', 'Stale schedules'],
      ['documentBacklog', 'Document backlog'],
      ['documentFailures', 'Document failures'],
    ],
  },
  {
    title: 'Capture',
    keys: [
      ['captureRemote', 'Remote'],
      ['captureInPerson', 'In person'],
      ['captureUnsupported', 'Unsupported'],
      ['transcriptReconnects', 'Reconnects'],
      ['segmentsPersisted', 'Segments persisted'],
      ['segmentRetries', 'Segment retries'],
    ],
  },
  {
    title: 'AI behaviour',
    keys: [
      ['providerErrors', 'Provider errors'],
      ['aiParseFailures', 'Parse failures'],
      ['templateFallbacks', 'Template fallbacks'],
      ['prohibitedOutputRefusals', 'Refusals'],
    ],
  },
  {
    title: 'Retention and cost',
    keys: [
      ['retentionRowsDeleted', 'Rows deleted'],
      ['retentionObjectsDeleted', 'Objects deleted'],
      ['retentionObjectFailures', 'Object failures'],
      ['usageVariances', 'Usage variances'],
    ],
  },
]

const CAPABILITY_LABELS: Array<[keyof InterviewOperations['capabilities'], string]> = [
  ['calendar', 'Calendar'],
  ['scheduling', 'Scheduling'],
  ['candidateUploads', 'Candidate uploads'],
  ['transcription', 'Transcription'],
  ['sensitiveAi', 'Sensitive AI'],
]

export function ReliabilitySection({ state }: SectionWidgetProps) {
  const [interviews, setInterviews] = React.useState<InterviewOperations | undefined>(undefined)

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/admin/metrics', { credentials: 'include', signal: controller.signal })
        if (!response.ok) return
        const body = await response.json()
        setInterviews(body.interviews)
      } catch {
        // Left undefined, which renders as loading rather than as "every capability is off". A failed read
        // must not look like a deliberate configuration.
      }
    })()
    return () => controller.abort()
  }, [])

  return (
    <>
      <MetricSectionView state={state} title="Feature reliability" />
      <InterviewOperationsSection interviews={interviews} />
    </>
  )
}

export function InterviewOperationsSection({ interviews }: { interviews: InterviewOperations | undefined }) {
  if (!interviews) {
    return (
      <section className="card p-5 mb-6" data-testid="metrics-interviews">
        <p className="text-sm text-bh-text-muted">Loading interview operations…</p>
      </section>
    )
  }

  const { capabilities, counters } = interviews
  // Counters the module reports but no group claims. Rendered rather than dropped: a counter added to
  // `metrics.ts` reaches the API automatically (`interviewOperatorCounters` derives its keys), so silently
  // discarding the unknown ones here would reintroduce exactly the gap that derivation closed.
  const grouped = new Set(INTERVIEW_COUNTER_GROUPS.flatMap((group) => group.keys.map(([key]) => key)))
  const ungrouped = Object.entries(counters ?? {}).filter(([key]) => !grouped.has(key))

  return (
    <section className="card p-5 mb-6" data-testid="metrics-interviews">
      <h2 className="font-semibold mb-3 flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Interview operations
      </h2>

      <div className="flex flex-wrap gap-2 mb-4" data-testid="metrics-interviews-capabilities">
        {CAPABILITY_LABELS.map(([key, label]) => (
          <span
            key={key}
            data-testid={`interview-capability-${key}`}
            className={`text-xs px-2 py-1 rounded border ${
              capabilities[key] ? 'border-bh-accent/40 text-bh-accent' : 'border-bh-border text-bh-text-dim'
            }`}
          >
            {label}: {capabilities[key] ? 'on' : 'off'}
          </span>
        ))}
      </div>

      {counters ? (
        <div className="space-y-4">
          {INTERVIEW_COUNTER_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">{group.title}</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {group.keys.map(([key, label]) => (
                  <MetricCard key={key} label={label} value={counters[key] ?? null} />
                ))}
              </div>
            </div>
          ))}
          {ungrouped.length > 0 && (
            <div data-testid="metrics-interviews-ungrouped">
              <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">Other counters</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {ungrouped.map(([key, value]) => (
                  <MetricCard key={key} label={key} value={value} />
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-bh-text-muted" data-testid="metrics-interviews-disabled">
          Every interview capability is disabled, so there is nothing to count. These counters are deliberately
          absent rather than shown as zeros — a zero here would read as &ldquo;no problems&rdquo; when it means
          &ldquo;no traffic is possible&rdquo;.
        </p>
      )}
    </section>
  )
}

export default ReliabilitySection
