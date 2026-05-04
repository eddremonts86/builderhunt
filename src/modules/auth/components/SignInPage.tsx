import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { signInEmail } from '~/shared/lib/auth/client'
import { Input } from '~/components/ui'
import { Code, ArrowLeft } from 'lucide-react'
import { Link } from '@tanstack/react-router'

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
      if (result.user) {
        navigate({ to: '/_dashboard/dashboard/' })
      } else {
        setError(result.error?.message ?? 'Sign in failed')
      }
    } catch (err) {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-bh-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <Link to="/_landing/" className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-8 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to home
        </Link>

        <div className="card">
          <h1 className="text-2xl font-bold text-bh-text mb-1">Welcome back</h1>
          <p className="text-bh-text-muted text-sm mb-6">Sign in to your BuilderHunt account</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm text-bh-text-muted block mb-1.5">Email</label>
              <Input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="text-sm text-bh-text-muted block mb-1.5">Password</label>
              <Input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full justify-center py-2.5"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <div className="flex-1 h-px bg-bh-border" />
            <span className="text-bh-text-muted text-xs">or</span>
            <div className="flex-1 h-px bg-bh-border" />
          </div>

          <Link
            to="/auth/sign-up"
            className="block text-center text-sm text-bh-text-muted hover:text-bh-text transition-colors"
          >
            Don&apos;t have an account? <span className="text-bh-accent">Sign up</span>
          </Link>
        </div>
      </div>
    </div>
  )
}