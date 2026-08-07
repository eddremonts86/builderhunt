/**
 * Wave 5 — Organization Admin section of the dashboard.
 *
 * Renders the six org-admin overview sections (members, billing, blocked
 * workflows, feature adoption, security posture, privacy requests) for
 * an owner/admin viewer. Renders nothing for non-admins; never asks for
 * a role that isn't already resolved server-side.
 *
 * Privacy contract (cannot be relaxed without an ADR):
 *   - never render per-member identity
 *   - never render candidate emails
 *   - never render productivity scores or rankings
 *   - never render session detail
 *   - never render member-level adoption scores (only org-aggregated)
 *   - never render search or note content
 *
 * The forbidden markers live in `admin-contracts.ts` so a server-side
 * grep can audit any new section for accidental inclusion.
 *
 * The widget reads from a single typed contract (`OrgAdminOverview`) and
 * maps each section envelope to a small client component. The state
 * `forbidden` omits capability details; `unavailable` reasons are
 * redacted to an enum (no config strings, no secret values).
 */
import * as React from 'react'
import type { z } from 'zod'
import {
  orgAdminOverviewSchema,
  type orgAdminActionSchema,
  type orgAdminBillingSchema,
  type orgAdminBlockedWorkflowsSchema,
  type orgAdminFeatureAdoptionSchema,
  type orgAdminMembersSchema,
  type orgAdminPrivacyRequestsSchema,
  type orgAdminSectionEnvelopeSchema,
  type orgAdminSecurityPostureSchema,
} from '~/shared/lib/dashboard/admin-contracts'

type OrgAdminOverview = z.infer<typeof orgAdminOverviewSchema>
type SectionEnvelope = z.infer<typeof orgAdminSectionEnvelopeSchema>
type Action = z.infer<typeof orgAdminActionSchema>

interface Props {
  /** Fully-resolved org-admin overview. Null when the role is not admin. */
  overview: OrgAdminOverview | null
}

export function OrganizationAdminSection({ overview }: Props) {
  if (!overview) return null

  return (
    <section
      aria-labelledby="org-admin-section-heading"
      data-testid="org-admin-section"
      className="space-y-4"
    >
      <header>
        <h2
          id="org-admin-section-heading"
          className="text-xl font-bold tracking-tight text-bh-text"
        >
          Organization administration
        </h2>
        <p className="text-sm text-bh-text-muted">
          Aggregated counts for owners and admins. Refreshed every 30 minutes.
        </p>
      </header>

      <SectionGrid>
        <SectionCard
          title="Members and seats"
          envelope={overview.sections.members}
          render={(data) => <MembersBlock data={data as z.infer<typeof orgAdminMembersSchema>} />}
        />
        <SectionCard
          title="Billing"
          envelope={overview.sections.billing}
          render={(data) => <BillingBlock data={data as z.infer<typeof orgAdminBillingSchema>} />}
        />
        <SectionCard
          title="Blocked workflows"
          envelope={overview.sections.blockedWorkflows}
          render={(data) => (
            <BlockedWorkflowsBlock
              data={data as z.infer<typeof orgAdminBlockedWorkflowsSchema>}
            />
          )}
        />
        <SectionCard
          title="Feature adoption"
          envelope={overview.sections.featureAdoption}
          render={(data) => (
            <FeatureAdoptionBlock
              data={data as z.infer<typeof orgAdminFeatureAdoptionSchema>}
            />
          )}
        />
        <SectionCard
          title="Security posture"
          envelope={overview.sections.securityPosture}
          render={(data) => (
            <SecurityPostureBlock
              data={data as z.infer<typeof orgAdminSecurityPostureSchema>}
            />
          )}
        />
        <SectionCard
          title="Data and privacy requests"
          envelope={overview.sections.privacyRequests}
          render={(data) => (
            <PrivacyRequestsBlock
              data={data as z.infer<typeof orgAdminPrivacyRequestsSchema>}
            />
          )}
        />
      </SectionGrid>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────
// Layout helpers
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
    return (
      <p className="text-sm text-bh-text-muted">Nothing to show yet.</p>
    )
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
            data-testid={`org-admin-action-${a.kind}`}
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

function MembersBlock({ data }: { data: z.infer<typeof orgAdminMembersSchema> }) {
  return (
    <>
      <p className="tabular-nums">
        <span className="font-bold text-bh-text">{data.totalMembers}</span> total members
        {' · '}
        <span className="font-bold text-bh-text">{data.activeSeats}</span> active seats
        {data.pendingInvitations > 0 && (
          <>
            {' · '}
            <span className="font-bold text-bh-accent">{data.pendingInvitations}</span> pending invitation{data.pendingInvitations === 1 ? '' : 's'}
          </>
        )}
      </p>
      <p className="text-xs text-bh-text-muted">
        {data.byRole.owner} owner · {data.byRole.admin} admin · {data.byRole.member} member
      </p>
    </>
  )
}

function BillingBlock({ data }: { data: z.infer<typeof orgAdminBillingSchema> }) {
  return (
    <>
      <p className="tabular-nums">
        Plan: <span className="font-bold text-bh-text capitalize">{data.tier}</span>
        {data.renewalDaysRemaining !== null && (
          <>
            {' · '}
            <span className="font-bold text-bh-text">{data.renewalDaysRemaining}</span> days to renewal
          </>
        )}
      </p>
      {data.approachingCap && (
        <p className="text-xs text-bh-text-accent">
          You are approaching the plan cap.
        </p>
      )}
    </>
  )
}

function BlockedWorkflowsBlock({ data }: { data: z.infer<typeof orgAdminBlockedWorkflowsSchema> }) {
  const kinds = Object.keys(data.blockedCounts)
  return (
    <>
      <p className="tabular-nums">
        <span className="font-bold text-bh-text">{data.total}</span> blocked workflow{data.total === 1 ? '' : 's'}
      </p>
      {kinds.length > 0 && (
        <ul className="text-xs text-bh-text-muted" role="list">
          {kinds.map((k) => (
            <li key={k} className="tabular-nums">
              {k}: <span className="text-bh-text">{data.blockedCounts[k]}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function FeatureAdoptionBlock({ data }: { data: z.infer<typeof orgAdminFeatureAdoptionSchema> }) {
  const features = Object.keys(data.rates)
  if (features.length === 0) {
    return <p className="text-sm text-bh-text-muted">No feature adoption data yet.</p>
  }
  return (
    <ul className="space-y-1" role="list">
      {features.map((f) => {
        const pct = Math.round((data.rates[f] ?? 0) * 100)
        return (
          <li key={f} className="text-xs tabular-nums flex items-center gap-2">
            <span className="flex-1 truncate text-bh-text-muted">{f}</span>
            <span
              className="font-bold text-bh-text"
              aria-label={`${f}: ${pct} percent adoption`}
            >
              {pct}%
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function SecurityPostureBlock({ data }: { data: z.infer<typeof orgAdminSecurityPostureSchema> }) {
  const staleCount = Object.keys(data.staleAdminDays).length
  return (
    <>
      <p className="tabular-nums">
        <span className="font-bold text-bh-text">{data.unverifiedAdmins}</span> admin
        {data.unverifiedAdmins === 1 ? '' : 's'} without verified email
      </p>
      {staleCount > 0 && (
        <p className="text-xs text-bh-text-muted">
          {staleCount} admin seat{staleCount === 1 ? '' : 's'} sign-in is older than 30 days.
        </p>
      )}
    </>
  )
}

function PrivacyRequestsBlock({ data }: { data: z.infer<typeof orgAdminPrivacyRequestsSchema> }) {
  return (
    <p className="tabular-nums">
      <span className="font-bold text-bh-text">{data.pending}</span> pending request{data.pending === 1 ? '' : 's'}
    </p>
  )
}
