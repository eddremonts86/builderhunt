import * as React from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Input, Button } from '~/components/ui'
import { ThemeToggle } from '~/shared/components/ThemeToggle'

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/auth/reset' })
  const token = (search as { token?: string })?.token
  const [password, setPassword] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [done, setDone] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!token) {
      setError('This reset link is missing its token. Request a new one.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password, token }),
      })
      if (res.ok) {
        setDone(true)
        setTimeout(() => navigate({ to: '/auth/sign-in' }), 1500)
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.message ?? 'This link is invalid or has expired. Request a new one.')
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
        <div className="flex items-center justify-between mb-8">
          <Link to="/auth/sign-in" className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm transition-colors">
            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to sign in
          </Link>
          <ThemeToggle />
        </div>

        <div className="card-glow">
          <div className="p-8">
            <h1 className="text-2xl font-bold tracking-tight mb-1">Set a new password</h1>
            <p className="text-sm text-bh-text-muted mb-6">
              Choose a new password for your BuilderHunt account.
            </p>

            {!token && (
              <div role="alert" className="mb-4 p-3 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger">
                This link is missing its token.{' '}
                <Link to="/auth/forgot" className="underline">Request a new one</Link>.
              </div>
            )}

            {done ? (
              <div role="status" className="p-3 rounded-lg border border-bh-success/30 bg-bh-success/10 text-sm text-bh-success">
                Password updated. Redirecting to sign in…
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <div>
                  <label htmlFor="password" className="text-sm font-medium text-bh-text block mb-1.5">
                    New password
                  </label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={8}
                    disabled={loading || !token}
                  />
                </div>

                {error && (
                  <div role="alert" className="p-3 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger">
                    {error}
                  </div>
                )}

                <Button type="submit" variant="primary" loading={loading} disabled={!token} className="w-full">
                  {loading ? 'Updating…' : 'Update password'}
                </Button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
