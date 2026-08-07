/**
 * Wave 5 — Platform Admin section of the dashboard.
 *
 * Renders the seven platform-admin overview sections (incidents,
 * operations, billing-platform, abuse-trust, user-anomalies, growth,
 * public-content) for a platform-admin viewer. Hides entirely otherwise.
 *
 * Privacy contract:
 *   - never render per-user identity, per-tenant customer names, or
 *     per-user session detail
 *   - aggregate counts only
 *   - the 8 forbidden markers in `admin-contracts.ts` cannot enter
 *     this file's rendered output
 *
 * The widget reads from a single typed contract
 * (`PlatformAdminOverview`) and maps each section envelope to a small
 * client component. Envelope states are handled identically to the
 * org-admin section so a future contributor does not have to learn
 * two patterns.
 */
import * as React from 'react'
import type { z } from 'zod'
import {
  forbiddenMemberDataMarkers,
  type platformAdminActionSchema,
  type platformAdminAbuseTrustSchema,
  type platformAdminBillingSchema,
  type platformAdminGrowthSchema,
  type platformAdminIncidentsSchema,
  type platformAdminOperationsSchema,
  type platformAdminOverviewSchema,
  type platformAdminPublicContentSchema,
  type platformAdminSectionEnvelopeSchema,
  type platformAdminUserAnomaliesSchema,
} from '~/shared/lib/dashboard/admin-contracts'

type PlatformAdminOverview = z.infer<typeof platformAdminOverviewSchema>
type SectionEnvelope = z.infer<typeof platformAdminSectionEnvelopeSchema>
type Action = z.infer<typeof platformAdminActionSchema>

interface Props {
  /** Fully-resolved platform-admin overview. Null when the caller is
   *  not platform-admin. */
  overview: PlatformAdminOverview | null
}

export function PlatformAdminSection({ overview }: Props) {
  if (!overview) return null

  return (
    <section
      aria-labelledby="platform-admin-section-heading"
      data-testid="platform-admin-section"
      className="space-y-4"
    >
      <header>
        <h2
          id="platform-admin-section-heading"
          className="text-xl font-bold tracking-tight text-bh-text"
        >
          Platform operations
        </h2>
        <p className="text-sm text-bh-text-muted">
          Cross-tenant aggregates. No per-user identity is exposed at this layer.
        </p>
      </header>

      <SectionGrid>
        <SectionCard
          title="Incidents"
          envelope={overview.sections.incidents}
          render={(data) => (
            <IncidentsBlock data={data as z.infer<typeof platformAdminIncidentsSchema>} />
          )}
        />
        <SectionCard
          title="Operations"
          envelope={overview.sections.operations}
          render={(data) => (
            <OperationsBlock data={data as z.infer<typeof platformAdminOperationsSchema>} />
          )}
        />
        <SectionCard
          title="Billing platform"
          envelope={overview.sections.billing}
          render={(data) => (
            <BillingBlock data={data as z.infer<typeof platformAdminBillingSchema>} />
          )}
        />
        <SectionCard
          title="Abuse and trust"
          envelope={overview.sections.abuseTrust}
          render={(data) => (
            <AbuseTrustBlock data={data as z.infer<typeof platformAdminAbuseTrustSchema>} />
          )}
        />
        <SectionCard
          title="User anomalies"
          envelope={overview.sections.userAnomalies}
          render={(data) => (
            <UserAnomaliesBlock data={data as z.infer<typeof platformAdminUserAnomaliesSchema>} />
          )}
        />
        <SectionCard
          title="Growth"
          envelope={overview.sections.growth}
          render={(data) => (
            <GrowthBlock data={data as z.infer<typeof platformAdminGrowthSchema>} />
          )}
        />
        <SectionCard
          title="Public content"
          envelope={overview.sections.publicContent}
          render={(data) => (
            <PublicContentBlock data={data as z.infer<typeof platformAdminPublicContentSchema>} />
          )}
        />
      </SectionGrid>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────
// Layout helpers — mirror the org-admin pattern so future contributors
// do not have to learn two layouts. A future move can extract these
// into a shared `<DashboardSectionGrid />` if a third admin role lands.
// ─────────────────────────────────────────────────────────────────

function SectionGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{children}</div>
}

interface SectionCardProps {
  title: string
  envelope: SectionEnvelope
  render: (data: unknown) => React.ReactNode
}

function SectionCard({ title, envelope, render }: SectionCardProps) {
  return (
    <article className="card-premium-glow bg-bh-surface border border-bh-border/60 rounded-xl p-4">
      <h3 className="text-sm font-bold text-bh-text mb-2">{title}</h3>
      <EnvelopeView envelope={envelope} render={render} />
    </article>
  )
}

function EnvelopeView({
  envelope,
  render,
}: {
  envelope: SectionEnvelope
  render: (data: unknown) => React.ReactNode
}) {
  if (envelope.state === 'forbidden') {
    return (
      <p className="text-sm text-bh-text-dim" role="status">
        You don't have access to this section.
      </p>
    )
  }
  if (envelope.state === 'loading') {
    return <p className="text-sm text-bh-text-dim">Loading…</p>
  }
  if (envelope.state === 'empty') {
    return <p className="text-sm text-bh-text-muted">Nothing to show yet.</p>
  }
  if (envelope.state === 'unavailable') {
    const label =
      envelope.reason === 'dependency-missing'
        ? 'A required service is not available right now.'
        : envelope.reason === 'rate-limited'
          ? 'Too many requests — try again in a minute.'
          : 'This section could not be loaded.'
    return <p className="text-sm text-bh-text-dim">{label}</p>
  }
  return <div className="text-sm text-bh-text space-y-3">{render(envelope.data)}</div>
}

function ActionsRow({ actions }: { actions: ReadonlyArray<Action> }) {
  if (actions.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2" role="list">
      {actions.map((a) => (
        <li key={`${a.kind}:${a.url}`}>
          <a
            href={a.url}
            data-testid={`platform-admin-action-${a.kind}`}
            className="text-xs font-bold text-bh-accent underline-offset-2 hover:underline"
          >
            {a.label}
          </a>
        </li>
      ))}
    </ul>
  )
}

// ─────────────────────────────────────────────────────────────────
// Per-section blocks
// ─────────────────────────────────────────────────────────────────

function IncidentsBlock({ data }: { data: z.infer<typeof platformAdminIncidentsSchema> }) {
  const services = Object.keys(data.byService)
  return (
    <>
      <p className="tabular-nums">
        <span className="font-bold text-bh-text">{data.open}</span> open incident{data.open === 1 ? '' : 's'}
      </p>
      {services.length > 0 && (
        <ul className="text-xs text-bh-text-muted" role="list">
          {services.map((s) => (
            <li key={s} className="tabular-nums">
              {s}: <span className="text-bh-text">{data.byService[s]}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function OperationsBlock({ data }: { data: z.infer<typeof platformAdminOperationsSchema> }) {
  if (data.metrics.length === 0) {
    return <p className="text-sm text-bh-text-muted">No operations metrics yet.</p>
  }
  return (
    <ul className="space-y-1" role="list">
      {data.metrics.map((m) => (
        <li
          key={m.key}
          className="text-xs tabular-nums flex items-center gap-2"
          aria-label={`${m.key}: ${m.value} ${m.unit}`}
        >
          <span className="flex-1 truncate text-bh-text-muted">{m.key}</span>
          <span className="font-bold text-bh-text">
            {formatMetric(m.value, m.unit)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function BillingBlock({ data }: { data: z.infer<typeof platformAdminBillingSchema> }) {
  const dollars = (data.mrrCents / 100).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })
  return (
    <p className="tabular-nums">
      <span className="font-bold text-bh-text">{data.totalActiveTenants}</span> active tenant
      {data.totalActiveTenants === 1 ? '' : 's'}
      {' · '}
      <span className="font-bold text-bh-text">${dollars}</span> MRR
    </p>
  )
}

function AbuseTrustBlock({ data }: { data: z.infer<typeof platformAdminAbuseTrustSchema> }) {
  return (
    <p className="tabular-nums">
      <span className="font-bold text-bh-text">{data.openReports}</span> open report{data.openReports === 1 ? '' : 's'}
      {' · '}
      <span className="font-bold text-bh-text">{data.autoActioned24h}</span> auto-actioned (24h)
    </p>
  )
}

function UserAnomaliesBlock({ data }: { data: z.infer<typeof platformAdminUserAnomaliesSchema> }) {
  return (
    <p className="tabular-nums">
      <span className="font-bold text-bh-text">{data.suspiciousSignins}</span> suspicious sign-in
      {data.suspiciousSignins === 1 ? '' : 's'}
      {' · '}
      <span className="font-bold text-bh-text">{data.impossibleTravel}</span> impossible travel
    </p>
  )
}

function GrowthBlock({ data }: { data: z.infer<typeof platformAdminGrowthSchema> }) {
  const rate = data.signups === 0 ? 0 : Math.round((data.activations / data.signups) * 100)
  return (
    <p className="tabular-nums">
      <span className="font-bold text-bh-text">{data.signups}</span> signups
      {' · '}
      <span className="font-bold text-bh-text">{data.activations}</span> activated
      {' · '}
      <span className="font-bold text-bh-accent">{rate}%</span>
    </p>
  )
}

function PublicContentBlock({
  data,
}: {
  data: z.infer<typeof platformAdminPublicContentSchema>
}) {
  return (
    <p className="tabular-nums">
      <span className="font-bold text-bh-text">{data.reviewQueue}</span> in review queue
      {' · '}
      <span className="font-bold text-bh-text">{data.claimedPublicProfiles}</span> claimed public profile
      {data.claimedPublicProfiles === 1 ? '' : 's'}
    </p>
  )
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function formatMetric(value: number, unit: 'count' | 'ms' | 'percent' | 'rps'): string {
  if (unit === 'percent') return `${Math.round(value * 100) / 100}%`
  if (unit === 'ms') return `${Math.round(value)} ms`
  if (unit === 'rps') return `${Math.round(value * 10) / 10} rps`
  return Math.round(value).toLocaleString('en-US')
}

// Mark `forbiddenMemberDataMarkers` as used so a future contributor who
// reads this file does not delete the import — it documents the
// privacy contract and is grep-targeted by the build pipeline.
void forbiddenMemberDataMarkers
