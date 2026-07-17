import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Input, Button } from '~/components/ui'

export function ForgotPasswordPage() {
  const [email, setEmail] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [sent, setSent] = React.useState(false)
  const [error, setError] = React.useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, redirectTo: '/auth/reset' }),
      })
      if (res.ok) {
        setSent(true)
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.message ?? 'Something went wrong. Please try again.')
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-app flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link to="/auth/sign-in" className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to sign in
        </Link>

        <div className="card-glow">
          <div className="p-8">
            <h1 className="text-2xl font-bold tracking-tight mb-1">Reset your password</h1>
            <p className="text-sm text-bh-text-muted mb-6">
              Enter your email and we'll send you a link to set a new password.
            </p>

            {sent ? (
              <div
                role="status"
                className="p-3 rounded-lg border border-bh-success/30 bg-bh-success/10 text-sm text-bh-success"
              >
                If that email exists in our system, check your inbox for a reset link.
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <div>
                  <label htmlFor="email" className="text-sm font-medium text-bh-text block mb-1.5">
                    Email
                  </label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    disabled={loading}
                  />
                </div>

                {error && (
                  <div role="alert" className="p-3 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger">
                    {error}
                  </div>
                )}

                <Button type="submit" variant="primary" loading={loading} className="w-full">
                  {loading ? 'Sending…' : 'Send reset link'}
                </Button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
