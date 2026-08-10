import * as React from 'react'
import { Check } from 'lucide-react'
import {
  INVITATION_INTENT_CAPABILITIES,
  INVITATION_INTENT_LABELS,
  INVITATION_SUGGESTED_QUERY,
  type InvitationIntent,
} from '~/shared/lib/organizations/invitation-personalization'

export interface InvitationValuePreviewProps {
  intent: InvitationIntent
  /** Sender-typed context. Rendered as their description, never as a verified fact. */
  roleTitle?: string | null
  organizationName?: string
  role?: 'admin' | 'member'
  /** `sender` labels it as a preview of what the recipient will see. */
  audience: 'sender' | 'recipient'
}

/**
 * The one card, rendered by both the sender's review step and the recipient's page.
 *
 * ## Why one component and not two
 *
 * The sender's whole reason to review is to see *what the recipient will see*. Two components would
 * drift — a bullet reworded on one side, a capability added to the other — and the drift is invisible
 * because nobody looks at both at once. The only difference this takes is `audience`, which changes the
 * framing sentence and nothing inside the list.
 *
 * ## Why it is static
 *
 * No search, no provider requests, no real people, no counts. This renders on a page reached from an
 * email by someone who is not a member yet, and every dynamic thing here would be either a query run
 * on behalf of a non-member or a number that changes before they accept. The capability lines describe
 * shipped, cross-tier behaviour, so they stay true whatever plan the organization is on the day they
 * click.
 */
export function InvitationValuePreview({
  intent,
  roleTitle,
  organizationName,
  role,
  audience,
}: InvitationValuePreviewProps) {
  const capabilities = INVITATION_INTENT_CAPABILITIES[intent]
  const suggested = INVITATION_SUGGESTED_QUERY[intent]

  return (
    <section
      className="rounded-lg border border-bh-border bg-bh-surface p-4"
      data-testid="invitation-value-preview"
      data-intent={intent}
      aria-label={audience === 'sender' ? 'Preview of what the recipient will see' : 'What you can do in BuilderHunt'}
    >
      {audience === 'sender' && (
        <p className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">
          What they will see
        </p>
      )}

      {organizationName && (
        <p className="text-sm text-bh-text mb-1" data-testid="invitation-preview-organization">
          <strong className="font-semibold">{organizationName}</strong>
          {role && <> invited you to join as {role === 'admin' ? 'an admin' : 'a member'}.</>}
        </p>
      )}

      {/*
        Attributed to the sender on purpose. Nobody verified this string — it is one person's
        description of another — and "They described the role as …" reports it where "Your role: …"
        would assert it.
      */}
      {roleTitle && (
        <p className="text-sm text-bh-text-muted mb-2" data-testid="invitation-preview-role-title">
          They described the role as &ldquo;{roleTitle}&rdquo;.
        </p>
      )}

      <p className="text-xs text-bh-text-dim mb-2">
        {INVITATION_INTENT_LABELS[intent]}
      </p>

      <ul className="space-y-1.5 mb-3" data-testid="invitation-preview-capabilities">
        {capabilities.map((capability) => (
          <li key={capability} className="flex items-start gap-2 text-sm text-bh-text-muted">
            <Check className="size-4 shrink-0 mt-0.5 text-bh-success" aria-hidden />
            <span>{capability}</span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-bh-text-dim" data-testid="invitation-preview-suggested-query">
        {audience === 'recipient' ? 'Your first search will start from' : 'Their first search will start from'}{' '}
        <code className="rounded bg-bh-bg-alt px-1 py-0.5">{suggested}</code>
      </p>
    </section>
  )
}
