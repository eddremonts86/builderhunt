import * as React from 'react'
import { useNavigate, Link, useSearch } from '@tanstack/react-router'
import { signInEmail } from '~/shared/lib/auth/client'
import { Input, Button } from '~/components/ui'
import { ArrowLeft } from 'lucide-react'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'
import { ThemeToggle } from '~/shared/components/ThemeToggle'

export function SignInPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/auth/sign-in' })
  const claimed = (search as { claimed?: string })?.claimed
  const claimError = (search as { claimError?: string })?.claimError
  const claimEmail = (search as { email?: string })?.email
  const [email, setEmail] = React.useState(claimEmail ?? '')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  // Where to send the user after a successful sign-in. Defaults to /dashboard
  // but honors ?redirect=... so onboarding/admin/etc. deep-links work.
  const safeRedirect = React.useMemo(() => {
    const r = (search as { redirect?: unknown })?.redirect
    if (typeof r !== 'string') return '/dashboard'
    // Only allow same-origin paths (must start with "/" and not "//")
    if (!r.startsWith('/') || r.startsWith('//')) return '/dashboard'
    return r
  }, [search])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await signInEmail({ email, password })
      if (result.data?.user) {
        navigate({ to: safeRedirect })
      } else {
        setError(result.error?.message ?? 'Sign in failed. Check your credentials and try again.')
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
          <Link to="/" className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm transition-colors">
            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to home
          </Link>
          <ThemeToggle />
        </div>

        <div className="card-glow">
          <div className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <BrandLogoMark size={32} />
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
                <p className="text-sm text-bh-text-muted">Sign in to your BuilderHunt account</p>
              </div>
            </div>

            {claimed && (
              <div
                role="status"
                className="mb-4 p-3 rounded-lg border border-bh-success/30 bg-bh-success/10 text-sm text-bh-success"
              >
                Profile claimed and verified! We created an account for you — use{' '}
                <Link to="/auth/forgot" className="underline">Forgot password?</Link> to set your password and sign in.
              </div>
            )}
            {claimError && (
              <div role="alert" className="mb-4 p-3 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger">
                {claimError}
              </div>
            )}

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
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="password" className="text-sm font-medium text-bh-text">
                    Password
                  </label>
                  <a href="/auth/forgot" className="text-xs text-bh-accent hover:underline">
                    Forgot?
                  </a>
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={8}
                  disabled={loading}
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="p-3 rounded-lg border border-bh-danger/30 bg-bh-danger/10 text-sm text-bh-danger"
                >
                  {error}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                loading={loading}
                className="w-full"
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <div className="my-6 flex items-center gap-3" aria-hidden="true">
              <div className="flex-1 h-px bg-bh-border" />
              <span className="text-bh-text-dim text-xs uppercase tracking-wider">or</span>
              <div className="flex-1 h-px bg-bh-border" />
            </div>

            <p className="text-center text-sm text-bh-text-muted">
              Don&apos;t have an account?{' '}
              <Link to="/auth/sign-up" className="text-bh-accent font-semibold hover:underline">
                Sign up
              </Link>
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-bh-text-dim mt-6">
          By signing in you agree to our{' '}
          <Link to="/legal/terms" className="underline hover:text-bh-text-muted">Terms</Link> and{' '}
          <Link to="/legal/privacy" className="underline hover:text-bh-text-muted">Privacy</Link>.
        </p>
      </div>
    </div>
  )
}
