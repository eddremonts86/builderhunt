/**
 * One composed route, rendered whole (plan 43 Phase 8, "Render complete evidence-backed routes").
 *
 * ## The rule this component exists to keep
 *
 * Never imply BuilderHunt verified a merely claimed capability. Almost everything in the catalog enters at
 * `claimed` — a vendor's own metadata, read from their own API — and nothing promotes it. So the evidence level
 * is rendered on every component, with words rather than only a colour, and the `claimed` case says who is
 * making the claim. A tick, a badge, or a confident summary would each turn a vendor's marketing into our
 * assessment.
 *
 * ## Everything the composer decided is shown, including the awkward parts
 *
 * Coverage gaps, limitations, risks, and human review points are not an appendix — they are what makes an
 * `available` route different from a `recommended` one, and hiding them would make the two statuses
 * indistinguishable to a reader. An unavailable lane shows its reason rather than disappearing: "we found
 * nothing" is an answer, and a missing card is not.
 */
import * as React from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, ExternalLink, Info, UserCheck } from 'lucide-react'
import type { SolutionRoute } from '~/shared/lib/solutions/contracts'

export type ExplanationProvenance = 'model' | 'deterministic'

export interface RouteCardProps {
  route: SolutionRoute
  /** Whether the prose was written by a model or by the deterministic composer. */
  provenance?: ExplanationProvenance
  fallbackReason?: string | null
  /** Per-component evidence levels, keyed by `componentId@version`. */
  evidenceLevels?: Record<string, string>
  /** Marks this route as the one the user chose. */
  chosen?: boolean
  onChoose?: (routeType: SolutionRoute['routeType']) => void
}

const ROUTE_TYPE_LABELS: Record<SolutionRoute['routeType'], string> = {
  human: 'Human',
  ai: 'AI',
  hybrid: 'Hybrid',
}

const STATUS_LABELS: Record<SolutionRoute['status'], string> = {
  recommended: 'Recommended',
  available: 'Available',
  unavailable: 'Unavailable',
}

/**
 * What each evidence level actually means, in the words a reader needs.
 *
 * `claimed` names the vendor as the source of the claim. That sentence is the single most important string in
 * this file: it is the difference between advice and repeating marketing.
 */
const EVIDENCE_LABELS: Record<string, string> = {
  claimed: 'Vendor’s own claim, unverified by us',
  observed: 'Observed by us at least once',
  verified: 'Verified against a reproducible check',
  production_evidence: 'Evidenced by production use',
}

export function RouteCard({ route, provenance, fallbackReason, evidenceLevels, chosen, onChoose }: RouteCardProps) {
  const unavailable = route.status === 'unavailable'

  return (
    <article
      className="card p-5 border border-bh-border/60 rounded-2xl flex flex-col gap-4"
      data-testid={`route-${route.routeType}`}
      data-status={route.status}
      aria-labelledby={`route-${route.routeType}-heading`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-bh-text-dim">{ROUTE_TYPE_LABELS[route.routeType]}</p>
          <h3 id={`route-${route.routeType}-heading`} className="text-base font-semibold mt-0.5">
            {route.summary}
          </h3>
        </div>
        <StatusPill status={route.status} />
      </header>

      {unavailable ? (
        <p className="text-sm text-bh-text-muted" data-testid={`route-${route.routeType}-unavailable-reason`}>
          {route.unavailableReason ?? route.fitExplanation}
        </p>
      ) : (
        <>
          <p className="text-sm text-bh-text-muted" data-testid={`route-${route.routeType}-fit`}>{route.fitExplanation}</p>

          {route.estimate && (
            <p className="text-sm" data-testid={`route-${route.routeType}-estimate`}>
              <span className="font-medium">
                {route.estimate.costMaxCents === 0
                  ? 'No direct cost'
                  : `${route.estimate.currency} ${(route.estimate.costMinCents / 100).toFixed(0)}–${(route.estimate.costMaxCents / 100).toFixed(0)}`}
              </span>
              <span className="text-bh-text-muted"> · {route.estimate.timeMinHours}–{route.estimate.timeMaxHours} hours</span>
            </p>
          )}

          {/* Assumptions sit with the estimate, not in a footnote: a price that depends on an assumption the
              reader never saw is a price they cannot check. */}
          {route.estimate && route.estimate.assumptions.length > 0 && (
            <ul className="text-xs text-bh-text-muted list-disc pl-4 space-y-0.5" data-testid={`route-${route.routeType}-assumptions`}>
              {route.estimate.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
            </ul>
          )}

          <Section title="What this route is made of" testId={`route-${route.routeType}-components`}>
            <ul className="space-y-2">
              {route.components.map((component) => {
                const level = evidenceLevels?.[`${component.componentId}@${component.componentVersion}`]
                return (
                  <li key={component.componentId} className="text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{component.componentId}</span>
                      {component.link && (
                        <a
                          href={component.link}
                          target="_blank"
                          rel="noreferrer noopener nofollow"
                          className="text-xs text-bh-accent inline-flex items-center gap-1"
                          data-testid={`route-${route.routeType}-link-${component.componentId}`}
                        >
                          Open <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-bh-text-muted">{component.role}</p>
                    {level && (
                      <p className="text-xs text-bh-text-dim" data-testid={`route-${route.routeType}-evidence-${component.componentId}`}>
                        {EVIDENCE_LABELS[level] ?? level}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </Section>

          <Section title="Steps" testId={`route-${route.routeType}-steps`}>
            <ol className="text-sm text-bh-text-muted list-decimal pl-4 space-y-1">
              {route.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </Section>

          {route.coverageGapCapabilityKeys.length > 0 && (
            <Callout tone="warning" icon={<AlertTriangle className="w-4 h-4" aria-hidden="true" />} testId={`route-${route.routeType}-gaps`}>
              Not covered by any component: {route.coverageGapCapabilityKeys.map((key) => key.replace(/_/g, ' ')).join(', ')}
            </Callout>
          )}

          {route.humanReviewPoints.length > 0 && (
            <Section title="A person must" testId={`route-${route.routeType}-review-points`} icon={<UserCheck className="w-4 h-4" aria-hidden="true" />}>
              <ul className="text-sm text-bh-text-muted list-disc pl-4 space-y-1">
                {route.humanReviewPoints.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </Section>
          )}

          {route.limitations.length > 0 && (
            <Section title="What we could not check" testId={`route-${route.routeType}-limitations`}>
              <ul className="text-sm text-bh-text-muted list-disc pl-4 space-y-1">
                {route.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
              </ul>
            </Section>
          )}

          {route.risks.length > 0 && (
            <Section title="Risks" testId={`route-${route.routeType}-risks`}>
              <ul className="text-sm text-bh-text-muted list-disc pl-4 space-y-1">
                {route.risks.map((risk) => <li key={risk}>{risk}</li>)}
              </ul>
            </Section>
          )}
        </>
      )}

      {/* Provenance last and quiet, but never absent: a reader is owed the difference between prose a model
          wrote and prose the composer wrote, and it is not recoverable from the text. */}
      {provenance && (
        <p className="text-xs text-bh-text-dim flex items-center gap-1" data-testid={`route-${route.routeType}-provenance`}>
          <Info className="w-3 h-3" aria-hidden="true" />
          {provenance === 'model'
            ? 'Wording generated from this route’s own evidence.'
            : `Wording written by the deterministic composer${fallbackReason ? ` (${fallbackReason.replace(/_/g, ' ')})` : ''}.`}
        </p>
      )}

      {onChoose && !unavailable && (
        <button
          type="button"
          className={chosen ? 'btn btn-primary self-start' : 'btn btn-secondary self-start'}
          onClick={() => onChoose(route.routeType)}
          data-testid={`route-${route.routeType}-choose`}
          aria-pressed={Boolean(chosen)}
        >
          {chosen ? 'Chosen' : 'I’ll use this one'}
        </button>
      )}
    </article>
  )
}

function StatusPill({ status }: { status: SolutionRoute['status'] }) {
  const tone = status === 'recommended'
    ? 'text-bh-success'
    : status === 'available' ? 'text-bh-text-muted' : 'text-bh-text-dim'
  const Icon = status === 'recommended' ? CheckCircle2 : status === 'available' ? Info : CircleSlash
  return (
    <span className={`text-xs font-semibold inline-flex items-center gap-1 ${tone}`} data-testid={`status-${status}`}>
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  )
}

function Section({ title, children, testId, icon }: {
  title: string
  children: React.ReactNode
  testId: string
  icon?: React.ReactNode
}) {
  return (
    <section data-testid={testId}>
      <h4 className="text-xs uppercase tracking-wider text-bh-text-dim mb-1 flex items-center gap-1">
        {icon}{title}
      </h4>
      {children}
    </section>
  )
}

function Callout({ tone, icon, children, testId }: {
  tone: 'warning'
  icon: React.ReactNode
  children: React.ReactNode
  testId: string
}) {
  return (
    <p
      className={`text-sm rounded-lg px-3 py-2 flex items-start gap-2 ${tone === 'warning' ? 'bg-bh-warning-soft text-bh-text' : ''}`}
      data-testid={testId}
    >
      <span className="mt-0.5">{icon}</span>
      <span>{children}</span>
    </p>
  )
}
