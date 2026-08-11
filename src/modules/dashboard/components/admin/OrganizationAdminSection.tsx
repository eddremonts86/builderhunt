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
  type OrgAdminSectionEnvelope,
  type orgAdminSecurityPostureSchema,
} from '~/shared/lib/dashboard/admin-contracts'

type OrgAdminOverview = z.infer<typeof orgAdminOverviewSchema>
type SectionEnvelope = OrgAdminSectionEnvelope
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
      /* `mt-6` because this is a new top-level section following the widget grid, not another card inside it —
         without it the heading sat flush against the row above and read as a caption for that row. */
      className="mt-6 space-y-4"
    >
      <header>
        <h2
          id="org-admin-section-heading"
          className="text-xl font-bold tracking-tight text-bh-text"
        >
          Organization administration
        </h2>
        {/* "Refreshed every 30 minutes" used to follow this sentence. Nothing refreshed it: the overview is
            fetched once on mount, the route sets no cache header, and there is no interval — so the only true
            statement about its age is the one the projection already carries in `generatedAt`. A cadence claim
            that no code implements is the same class of defect as a count with no query behind it. */}
        <p className="text-sm text-bh-text-muted">
          Aggregated counts for owners and admins. Never per-person detail.
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
      {/* The body is addressable on its own so a test can assert about the values without the card's title being
          part of the string. "Members and seats" contains the word "seats", so a check for "no unit word without a
          number" reads the title as a violation when it is handed the whole card. */}
      <div data-testid="org-admin-card-body">
        <EnvelopeView envelope={envelope} render={render} />
      </div>
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
        ? /**
           * Not "a required service is not available right now", which is what this said.
           *
           * That sentence describes an outage, and three of these six cards carry this reason permanently — so a
           * brand-new workspace opened its dashboard to what read as a partial failure of the product. The reason
           * is a *missing feature*, not a broken one: two of the three have no table in any migration, and the
           * third would need a privilege the tenant connection is deliberately not granted. Saying "not available
           * yet" is both true and un-alarming, and it does not send anyone to the status page.
           */
          'Not available yet.'
        : envelope.reason === 'rate-limited'
          ? 'Too many requests — try again in a minute.'
          : 'This section could not be loaded.'
    return <p className="text-sm text-bh-text-dim">{label}</p>
  }
  return (
    <div className="text-sm text-bh-text space-y-3">
      {render(envelope.data)}
      {/* The link to the page that can act on the number. `ActionsRow` returns null for an empty list, which is
          what the three unbuilt sections send — there is no page for a feature that does not exist. */}
      <ActionsRow actions={envelope.actions} />
    </div>
  )
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

/**
 * Members and seats.
 *
 * Every value here is rendered only when the projection produced it. The version this replaces read
 * `data.totalMembers` and `data.activeSeats` — fields the projection stopped emitting on 2026-08-11 — so it drew
 * the sentence "total members · active seats" with the numbers missing, which is the one thing this plan exists to
 * prevent. The contract validates the payload now (`orgAdminSectionEnvelope`), so a repeat of that rename fails the
 * route's `parse()` rather than reaching a card.
 */
function MembersBlock({ data }: { data: z.infer<typeof orgAdminMembersSchema> }) {
  return (
    <>
      <p className="tabular-nums">
        <span className="font-bold text-bh-text">{data.total}</span> member{data.total === 1 ? '' : 's'}
        {/* The cap, only when the plan sets one. `null` is "no entitlement row", which is not a cap of zero. */}
        {data.seatLimit !== null && (
          <>
            {' of '}
            <span className="font-bold text-bh-text">{data.seatLimit}</span> seat{data.seatLimit === 1 ? '' : 's'}
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
        Plan: <span className="font-bold text-bh-text capitalize">{data.tier.replace('_', ' ')}</span>
        {' · '}
        <span className="capitalize">{data.status.replace('_', ' ')}</span>
      </p>
      {/* Rendered only when there is a scheduled renewal. The previous version tested `!== null` against a field
          the projection had renamed, so `undefined !== null` was true and it drew "· days to renewal" with no
          number — the same defect as the members card, from the same cause. */}
      {data.renewalDays !== null && (
        <p className="text-xs text-bh-text-muted tabular-nums">
          Renews in <span className="font-bold text-bh-text">{data.renewalDays}</span> day{data.renewalDays === 1 ? '' : 's'}.
        </p>
      )}
      {data.approachingSeatCap && (
        <p className="text-xs text-bh-warning">
          You are approaching the seat limit on this plan.
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

/**
 * Deletion and export requests, per kind and status.
 *
 * The kinds are listed in a fixed order rather than in whatever order the payload's keys happen to arrive in, so
 * the card does not reorder itself between two reads of the same workspace.
 */
const PRIVACY_KINDS = [
  { key: 'deletion', label: 'Deletion' },
  { key: 'export', label: 'Export' },
] as const

function PrivacyRequestsBlock({ data }: { data: z.infer<typeof orgAdminPrivacyRequestsSchema> }) {
  const present = PRIVACY_KINDS.map((kind) => ({
    ...kind,
    byStatus: data.byKind[kind.key] ?? {},
  })).filter((kind) => Object.keys(kind.byStatus).length > 0)

  // The envelope answers `empty` when there is nothing at all, so reaching this with no kinds would mean the
  // projection said `ready` over an empty group — worth showing as unknown rather than as zero.
  if (present.length === 0) {
    return <p className="text-sm text-bh-text-muted">No request counts were returned.</p>
  }

  return (
    <ul className="space-y-1" role="list">
      {present.map((kind) => (
        <li key={kind.key} className="text-xs tabular-nums">
          <span className="text-bh-text-muted">{kind.label}: </span>
          {Object.entries(kind.byStatus)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([status, count], index) => (
              <span key={status}>
                {index > 0 && ' · '}
                <span className="font-bold text-bh-text">{count}</span> {status.replace('_', ' ')}
              </span>
            ))}
        </li>
      ))}
    </ul>
  )
}
