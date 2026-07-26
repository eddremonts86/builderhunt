import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CheckCircle2, ShieldOff } from 'lucide-react'
import { Button, Input, Label } from '~/components/ui'

/**
 * Plan: audit-trust. Public, unauthenticated profile-removal request/verify flow — see
 * src/shared/lib/profile-removal.ts for the server-side mechanics this calls into.
 */
export const Route = createFileRoute('/_landing/privacy/remove')({
  component: RemoveProfilePage,
  head: () => ({
    meta: [
      { title: 'Remove my profile — BuilderHunt' },
      { name: 'description', content: 'Request removal of a GitHub, GitLab, Codeberg, or DEV.to profile from BuilderHunt.' },
    ],
  }),
})

const VERIFY_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'This removal request was not found. Start a new one below.',
  expired: 'This request expired. Start a new one below.',
  invalid_challenge: 'That code does not match this request. Copy it again from the box above.',
  challenge_missing: 'We could not find the code in your bio yet. Add it, save your profile, then try verifying again.',
  not_found_upstream: 'We could not reach that profile. Double-check the URL and try again.',
  rate_limited: 'The source is rate-limiting us right now. Wait a moment and try verifying again.',
  timeout: 'The source did not respond in time. Try verifying again in a moment.',
  unsupported: 'Automated verification is not available for this source yet.',
}

type Step =
  | { kind: 'form' }
  | { kind: 'issued'; requestId: string; challenge: string; instructions: string }
  | { kind: 'manual'; message: string }
  | { kind: 'verified' }

function RemoveProfilePage() {
  const [profileUrl, setProfileUrl] = React.useState('')
  const [requesterEmail, setRequesterEmail] = React.useState('')
  const [step, setStep] = React.useState<Step>({ kind: 'form' })
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/privacy/profile-removal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileUrl,
          ...(requesterEmail ? { requesterEmail } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Something went wrong. Try again.')
        return
      }
      if (data.manualReview) {
        setStep({ kind: 'manual', message: data.message ?? 'This source needs manual review.' })
        return
      }
      setStep({ kind: 'issued', requestId: data.requestId, challenge: data.challenge, instructions: data.instructions })
    } catch {
      setError('Network error. Try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify() {
    if (step.kind !== 'issued') return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/privacy/profile-removal/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: step.requestId, challenge: step.challenge }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const key = typeof data.error === 'string' ? data.error : 'unknown'
        setError(VERIFY_ERROR_MESSAGES[key] ?? 'Verification failed. Try again.')
        return
      }
      setStep({ kind: 'verified' })
    } catch {
      setError('Network error. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <article className="container py-12 max-w-3xl animate-fade-in" data-testid="privacy-remove">
      <div className="card p-8 md:p-12 border border-bh-border/60 bg-bh-surface rounded-2xl shadow-sm">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight flex items-center gap-3 mb-2">
            <ShieldOff className="w-7 h-7 text-bh-accent" aria-hidden="true" />
            Remove my profile
          </h1>
          <p className="text-bh-text-muted leading-relaxed">
            This stops a specific GitHub, GitLab, Codeberg, or DEV.to profile from appearing
            anywhere on BuilderHunt — search, tracked lists, exports, feeds, and alerts — for
            every user, not just you. It is different from{' '}
            <Link to="/legal/privacy" className="text-bh-accent underline">deleting a BuilderHunt account</Link>{' '}
            (which you do not need to have) and from{' '}
            correcting your own claimed profile&apos;s details. It also cannot delete anything on
            the upstream platform itself — see <Link to="/security" className="text-bh-accent underline">Security</Link>.
          </p>
        </header>

        {step.kind === 'form' && (
          <form onSubmit={handleRequest} className="space-y-5" data-testid="remove-form">
            <div>
              <Label htmlFor="profileUrl">Profile URL</Label>
              <Input
                id="profileUrl"
                type="url"
                required
                placeholder="https://github.com/your-username"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                data-testid="remove-profile-url"
              />
              <p className="text-xs text-bh-text-dim mt-1">A GitHub, GitLab, Codeberg, or DEV.to profile URL — one person, not a repository.</p>
            </div>
            <div>
              <Label htmlFor="requesterEmail">Email (optional)</Label>
              <Input
                id="requesterEmail"
                type="email"
                placeholder="you@example.com"
                value={requesterEmail}
                onChange={(e) => setRequesterEmail(e.target.value)}
                data-testid="remove-email"
              />
              <p className="text-xs text-bh-text-dim mt-1">Only used to confirm we can reach you about this request — never used as proof of ownership by itself.</p>
            </div>
            {error && <p className="text-sm text-bh-danger" role="alert">{error}</p>}
            <Button type="submit" disabled={loading} data-testid="remove-submit">
              {loading ? 'Submitting…' : 'Continue'}
            </Button>
          </form>
        )}

        {step.kind === 'manual' && (
          <div className="space-y-4" data-testid="remove-manual">
            <p className="text-bh-text-muted leading-relaxed">{step.message}</p>
            <Button onClick={() => setStep({ kind: 'form' })} variant="secondary">Start another request</Button>
          </div>
        )}

        {step.kind === 'issued' && (
          <div className="space-y-5" data-testid="remove-issued">
            <ol className="list-decimal pl-6 space-y-3 text-bh-text-muted leading-relaxed">
              <li>Copy the code below.</li>
              <li>Paste it into your profile&apos;s bio field on the source you gave us, and save.</li>
              <li>Come back here and click &quot;Verify&quot;. You can remove the code afterward.</li>
            </ol>
            <div className="card p-4 bg-bh-bg-alt/50 border border-bh-border/60 font-mono text-sm break-all" data-testid="remove-challenge">
              {step.challenge}
            </div>
            <p className="text-sm text-bh-text-dim">{step.instructions}</p>
            {error && <p className="text-sm text-bh-danger" role="alert">{error}</p>}
            <div className="flex gap-3">
              <Button onClick={handleVerify} disabled={loading} data-testid="remove-verify">
                {loading ? 'Verifying…' : 'Verify'}
              </Button>
              <Button onClick={() => setStep({ kind: 'form' })} variant="secondary">Start over</Button>
            </div>
          </div>
        )}

        {step.kind === 'verified' && (
          <div className="space-y-4" data-testid="remove-verified">
            <p className="flex items-center gap-2 text-bh-success font-semibold">
              <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
              Verified — this profile is being removed from BuilderHunt.
            </p>
            <p className="text-sm text-bh-text-muted leading-relaxed">
              It will stop appearing in search, tracked lists, exports, feeds, and alerts across
              every BuilderHunt account. This does not affect your profile on the source platform
              itself.
            </p>
          </div>
        )}

        <div className="mt-10 pt-8 border-t border-bh-border/50 text-sm text-bh-text-dim">
          Questions, or need a source we don&apos;t support yet?{' '}
          <a href="mailto:privacy@builderhunt.dev" className="text-bh-accent underline">privacy@builderhunt.dev</a>.
        </div>
      </div>
    </article>
  )
}
