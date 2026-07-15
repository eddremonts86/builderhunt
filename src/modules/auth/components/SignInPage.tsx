import * as React from 'react'
import { useNavigate, Link } from '@tanstack/react-router'
import { signInEmail } from '~/shared/lib/auth/client'
import { Input, Button } from '~/components/ui'
import { ArrowLeft } from 'lucide-react'

function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-xl shrink-0"
      style={{ width: size, height: size, background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
      aria-hidden="true"
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
        <path d="M5 4h7a4 4 0 0 1 4 4v1" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M16 4h3a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-7a4 4 0 0 0-4 4v3" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M8 20H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h7a4 4 0 0 0 4-4V7" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="11" cy="12" r="1.8" fill="#06b6d4" />
      </svg>
    </span>
  )
}

export function SignInPage() {
  const navigate = useNavigate()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await signInEmail({ email, password })
      if (result.data?.user) {
        navigate({ to: '/dashboard' })
      } else {
        setError(result.error?.message ?? 'Sign in failed. Check your credentials and try again.')
      }
    } catch (err) {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-app flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link to="/" className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to home
        </Link>

        <div className="card-glow">
          <div className="p-8">
            <div className="flex items-center gap-3 mb-6">
              <LogoMark />
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
                <p className="text-sm text-bh-text-muted">Sign in to your BuilderHunt account</p>
              </div>
            </div>

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
          <a href="/terms" className="underline hover:text-bh-text-muted">Terms</a> and{' '}
          <a href="/privacy" className="underline hover:text-bh-text-muted">Privacy</a>.
        </p>
      </div>
    </div>
  )
}
