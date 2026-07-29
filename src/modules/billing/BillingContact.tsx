import * as React from 'react'
import { Mail, CheckCircle2 } from 'lucide-react'
import { Button, Input, Label } from '~/components/ui'

interface BillingContact {
  email: string
  verifiedAt: string | null
}

interface BillingContactResponse {
  contact: BillingContact | null
}

async function fetchContact(): Promise<BillingContact | null> {
  const res = await fetch('/api/billing/contact', { credentials: 'include' })
  if (!res.ok) return null
  const data = (await res.json()) as BillingContactResponse
  return data.contact
}

/**
 * Owner-only billing contact card (plans/phase-1/30-stripe-billing-platform/tasks.md §9 task 4). Shows the
 * currently VERIFIED contact only — a pending, unconfirmed address is never shown as if active, since
 * the owner already sees the "check your inbox" confirmation immediately after submitting.
 */
export function BillingContact() {
  const [contact, setContact] = React.useState<BillingContact | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [email, setEmail] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [devLink, setDevLink] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetchContact().then((c) => {
      setContact(c)
      setLoading(false)
    })
  }, [])

  const submit = async () => {
    setSaving(true)
    setError(null)
    setMessage(null)
    setDevLink(null)
    try {
      const res = await fetch('/api/billing/contact', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to set billing contact')
        return
      }
      setMessage(data.message ?? 'Check the new address for a verification link.')
      if (data.devLink) setDevLink(data.devLink)
      setEmail('')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return null

  return (
    <div className="space-y-4" data-testid="billing-contact">
      <div>
        <h3 className="text-sm font-bold text-bh-text flex items-center gap-2">
          <Mail className="w-4 h-4" aria-hidden="true" />
          Billing contact
        </h3>
        <p className="text-xs text-bh-text-muted mt-1">
          Receipts and payment notices go to this address in addition to the owner. Setting a contact grants no
          account membership or authority.
        </p>
      </div>

      {contact ? (
        <div className="flex items-center gap-2 text-sm text-bh-text" data-testid="billing-contact-current">
          <CheckCircle2 className="w-4 h-4 text-bh-success shrink-0" aria-hidden="true" />
          <span>{contact.email}</span>
          <span className="text-xs text-bh-text-dim">verified</span>
        </div>
      ) : (
        <p className="text-xs text-bh-text-dim" data-testid="billing-contact-none">No verified billing contact yet.</p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor="billing-contact-email">{contact ? 'Replace with a new address' : 'Set a billing contact'}</Label>
          <Input
            id="billing-contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="billing@example.com"
            data-testid="billing-contact-input"
          />
        </div>
        <Button type="button" onClick={submit} disabled={saving || !email} data-testid="billing-contact-submit">
          {saving ? 'Sending…' : 'Send verification'}
        </Button>
      </div>

      {error && <p className="text-xs text-bh-danger" role="alert" data-testid="billing-contact-error">{error}</p>}
      {message && <p className="text-xs text-bh-success" data-testid="billing-contact-message">{message}</p>}
      {devLink && (
        <p className="text-[11px] text-bh-text-dim break-all" data-testid="billing-contact-dev-link">
          Dev link: <a href={devLink} className="underline">{devLink}</a>
        </p>
      )}
    </div>
  )
}
