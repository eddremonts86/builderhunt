import * as React from 'react'
import { useNavigate, Link } from '@tanstack/react-router'
import { signUpEmail } from '~/shared/lib/auth/client'
import { Input, Button } from '~/components/ui'
import { ArrowLeft, Check } from 'lucide-react'

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

export function SignUpPage() {
  const navigate = useNavigate()
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const result = await signUpEmail({ email, password, name: name || undefined })
      if (result.data?.user) {
        // Ensure onboarding row exists, then redirect to the tour
        try {
          await fetch('/api/onboarding/complete', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: 0 }),
          })
        } catch {}
        navigate({ to: '/onboarding/welcome' })
      } else {
        setError(result.error?.message ?? 'Sign up failed. Try again or use a different email.')
      }
    } catch (err) {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const passwordChecks = [
    { ok: password.length >= 8, label: 'At least 8 characters' },
    { ok: /[A-Za-z]/.test(password) && /[0-9]/.test(password), label: 'Letters and numbers' },
  ]

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
                <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
                <p className="text-sm text-bh-text-muted">Free during public beta. No credit card.</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div>
                <label htmlFor="name" className="text-sm font-medium text-bh-text block mb-1.5">
                  Name <span className="text-bh-text-dim font-normal">(optional)</span>
                </label>
                <Input
                  id="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  disabled={loading}
                />
              </div>
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
                <label htmlFor="password" className="text-sm font-medium text-bh-text block mb-1.5">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                  disabled={loading}
                />
                {password && (
                  <ul className="mt-2 space-y-1 text-xs" aria-live="polite">
                    {passwordChecks.map((c) => (
                      <li key={c.label} className={`flex items-center gap-1.5 ${c.ok ? 'text-bh-success' : 'text-bh-text-dim'}`}>
                        <Check className="w-3 h-3" aria-hidden="true" />
                        {c.label}
                      </li>
                    ))}
                  </ul>
                )}
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
                disabled={password.length < 8}
              >
                {loading ? 'Creating account…' : 'Create account'}
              </Button>
            </form>

            <p className="text-center text-sm text-bh-text-muted mt-6">
              Already have an account?{' '}
              <Link to="/auth/sign-in" className="text-bh-accent font-semibold hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-bh-text-dim mt-6">
          By creating an account you agree to our{' '}
          <a href="/terms" className="underline hover:text-bh-text-muted">Terms</a> and{' '}
          <a href="/privacy" className="underline hover:text-bh-text-muted">Privacy</a>.
        </p>
      </div>
    </div>
  )
}
