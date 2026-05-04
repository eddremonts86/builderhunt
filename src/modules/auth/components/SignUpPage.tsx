import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { signUpEmail } from '~/shared/lib/auth/client'
import { Input } from '~/components/ui'
import { Link } from '@tanstack/react-router'

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
      if (result.user) {
        navigate({ to: '/_dashboard/dashboard/' })
      } else {
        setError(result.error?.message ?? 'Sign up failed')
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
          ← Back to home
        </Link>

        <div className="card">
          <h1 className="text-2xl font-bold text-bh-text mb-1">Create your account</h1>
          <p className="text-bh-text-muted text-sm mb-6">Start discovering active builders</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm text-bh-text-muted block mb-1.5">Name (optional)</label>
              <Input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
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
                placeholder="Min 8 characters"
                minLength={8}
                required
              />
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full justify-center py-2.5"
            >
              {loading ? 'Creating account...' : 'Create account'}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-bh-text-muted">
            Already have an account?{' '}
            <Link to="/auth/sign-in" className="text-bh-accent hover:underline">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}