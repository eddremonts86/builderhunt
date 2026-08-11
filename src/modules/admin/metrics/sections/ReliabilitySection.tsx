import * as React from 'react'
import { CalendarClock } from 'lucide-react'
import { MetricSectionView } from '../MetricSectionView'
import type { SectionWidgetProps } from '../MetricSectionView'

/**
 * Feature reliability (plan 57, Admin track — "Build Feature Reliability metrics with interview signals
 * first").
 *
 * The task says interview signals first, and the reason is that they are the only per-feature reliability
 * numbers that exist. A general availability percentage would need per-feature availability samples over a
 * window and nothing writes those, so the `availability` variant answers `insufficient_history` rather than a
 * 100 % derived from the absence of evidence.
 *
 * ## What this component renders, and what it no longer does
 *
 * The **counters** come from the section contract now, with their thresholds and their process scope stated per
 * value — so they are rendered by the shared `MetricSectionView` and a breach links to Operations like every
 * other section's.
 *
 * What is left here is the **capability grid**, and only because the contract cannot carry it: `metricValueSchema`
 * accepts a finite number and these are booleans. They are shown individually rather than rolled into one
 * "interviews: on" because they fail independently — transcription can be off while scheduling is on, and an
 * operator reading `transcript_reconnects: 0` needs to know which of those two it is. The section itself says
 * `not_enabled` when *every* door is shut, which is the case where the counters would be zero by construction.
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
}

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

  const { capabilities } = interviews

  return (
    <section className="card p-5 mb-6" data-testid="metrics-interviews">
      <h2 className="font-semibold mb-3 flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Interview capabilities
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

      {Object.values(capabilities).some(Boolean) ? (
        <p className="text-sm text-bh-text-muted">
          The counters above are cumulative since this process started, and a door that is off means its counter
          cannot move — which is why these flags are shown individually rather than rolled into one.
        </p>
      ) : (
        <p className="text-sm text-bh-text-muted" data-testid="metrics-interviews-disabled">
          Every interview capability is disabled, so there is nothing to count. The counters are deliberately
          absent rather than shown as zeros — a zero here would read as &ldquo;no problems&rdquo; when it means
          &ldquo;no traffic is possible&rdquo;.
        </p>
      )}
    </section>
  )
}

export default ReliabilitySection
