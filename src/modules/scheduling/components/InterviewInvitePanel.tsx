/**
 * The "Invite to interview" card on a tracked builder's profile (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Build organizer scheduling UI").
 *
 * Owns the three-step walk — compose, preview, sent — and the list of invitations already issued for
 * this builder. Kept in one place because the steps share one draft: a failed send has to return the
 * organizer to a preview that still knows what they wrote, and a cleared form after a provider error
 * would cost them their role context for a reason unrelated to it.
 *
 * Renders nothing when scheduling is off. The flag is a release gate rather than an entitlement, so
 * an empty card explaining a feature nobody can use would be noise; the list request answers `503`
 * and this collapses.
 */
import * as React from 'react'
import { Button } from '~/components/ui'
import { InvitationComposer, type CreatedDraft } from './InvitationComposer'
import { InvitationPreview } from './InvitationPreview'
import { InvitationStatus, type InvitationSummary } from './InvitationStatus'

interface InterviewInvitePanelProps {
  /** `organization_builders.id`, from the profile DTO's `trackedId`. Absent for an untracked builder. */
  organizationBuilderId?: string | null
  builderName: string
}

type Step =
  | { kind: 'idle' }
  | { kind: 'composing' }
  | { kind: 'previewing'; draft: CreatedDraft; sentTo: string }
  | { kind: 'sent'; roleTitle: string }

export function InterviewInvitePanel({ organizationBuilderId, builderName }: InterviewInvitePanelProps) {
  const [available, setAvailable] = React.useState<boolean | null>(null)
  const [invitations, setInvitations] = React.useState<InvitationSummary[]>([])
  const [step, setStep] = React.useState<Step>({ kind: 'idle' })

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/scheduling/invitations', { credentials: 'include' })
      if (res.status === 503) return setAvailable(false)
      if (!res.ok) return setAvailable(false)
      // The route answers `{ invitations: [...] }`, not a bare array. Read from the documented shape
      // rather than tolerating both: silently accepting an array too would have hidden this typo
      // behind an empty list, which is exactly how it first showed up.
      const body = await res.json().catch(() => ({ invitations: [] }))
      const rows: InvitationSummary[] = Array.isArray(body?.invitations) ? body.invitations : []
      setAvailable(true)
      // The endpoint returns the organizer's invitations across builders; this card is about one, so
      // it shows only those linked to it. An invitation with no link is not shown here at all rather
      // than being attributed to whichever profile happened to be open.
      setInvitations(
        rows.filter((row) => (organizationBuilderId ? row.organizationBuilderId === organizationBuilderId : false)),
      )
    } catch {
      setAvailable(false)
    }
  }, [organizationBuilderId])

  React.useEffect(() => { void load() }, [load])

  if (available === null || available === false) return null

  return (
    <div className="card p-5" data-testid="interview-invite-panel">
      <h3 className="mb-1 text-base font-semibold text-bh-text">Invite to interview</h3>

      {step.kind === 'idle' ? (
        <>
          <p className="mb-3 text-xs text-bh-text-muted">
            Send {builderName} a link to pick a time from your availability. They do not need an
            account.
          </p>
          <InvitationStatus invitations={invitations} onChanged={load} />
          <div className="mt-3">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => setStep({ kind: 'composing' })}
              disabled={!organizationBuilderId}
              data-testid="invitation-start"
            >
              New invitation
            </Button>
            {organizationBuilderId ? null : (
              <p className="mt-2 text-xs text-bh-text-muted">
                Track this builder first — an invitation is recorded against your tracked copy of
                them.
              </p>
            )}
          </div>
        </>
      ) : null}

      {step.kind === 'composing' ? (
        <InvitationComposer
          organizationBuilderId={organizationBuilderId}
          suggestedContext={`Interview with ${builderName}.`}
          onCreated={(draft, sentTo) => setStep({ kind: 'previewing', draft, sentTo })}
          onCancel={() => setStep({ kind: 'idle' })}
        />
      ) : null}

      {step.kind === 'previewing' ? (
        <InvitationPreview
          draft={step.draft}
          sentTo={step.sentTo}
          onSent={() => {
            setStep({ kind: 'sent', roleTitle: step.draft.roleTitle })
            void load()
          }}
          // Back to the composer would re-create a second draft, so this returns to the list, where
          // the draft is visible and revocable.
          onBack={() => { setStep({ kind: 'idle' }); void load() }}
        />
      ) : null}

      {step.kind === 'sent' ? (
        <div className="space-y-3" data-testid="invitation-sent">
          <p className="text-sm text-bh-text">
            Sent. {builderName} has the link for <strong>{step.roleTitle}</strong>.
          </p>
          <p className="text-xs text-bh-text-muted">
            You will see the status change here when they open it and when they book.
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setStep({ kind: 'idle' }); void load() }}>
            Done
          </Button>
        </div>
      ) : null}
    </div>
  )
}
