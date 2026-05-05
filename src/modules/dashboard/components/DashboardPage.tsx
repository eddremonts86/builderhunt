import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Users, TrendingUp, Bookmark, ExternalLink } from 'lucide-react'

interface Stats {
  totalBuilders: number
  activeThisWeek: number
  savedQueries: number
  totalNotes: number
}

interface SavedQuery {
  id: string
  name: string
  keywords: string[]
  sources: string[]
  createdAt: string
}

export function DashboardPage() {
  const [stats, setStats] = React.useState<Stats | null>(null)
  const [queries, setQueries] = React.useState<SavedQuery[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    Promise.all([
      fetch('/api/dashboard/stats', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/queries', { credentials: 'include' }).then(r => r.json()),
    ]).then(([s, q]) => {
      setStats(s)
      setQueries(Array.isArray(q) ? q : [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-bh-text-muted">Loading...</p>
      </div>
    )
  }

  const statsData = [
    { label: 'Builders tracked', value: stats?.totalBuilders ?? 0, icon: Users, color: 'text-bh-accent' },
    { label: 'Active this week', value: stats?.activeThisWeek ?? 0, icon: TrendingUp, color: 'text-green-400' },
    { label: 'Saved queries', value: stats?.savedQueries ?? 0, icon: Bookmark, color: 'text-yellow-400' },
  ]

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-bh-text mb-1">Dashboard</h1>
        <p className="text-bh-text-muted">Track and discover active builders</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-6 mb-10">
        {statsData.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card flex items-center gap-4">
            <div className={`p-3 rounded-xl bg-bh-accent/10 ${color}`}>
              <Icon className="w-6 h-6" />
            </div>
            <div>
              <p className="text-3xl font-bold text-bh-text">{value}</p>
              <p className="text-sm text-bh-text-muted">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Saved queries */}
      {queries.length > 0 && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold text-bh-text mb-4">Saved searches</h2>
          <div className="space-y-2">
            {queries.map(q => (
              <div key={q.id} className="flex items-center justify-between py-2 border-b border-bh-border last:border-0">
                <div>
                  <p className="font-medium text-bh-text text-sm">{q.name}</p>
                  <p className="text-xs text-bh-text-muted">{q.keywords.join(', ')}</p>
                </div>
                <Link
                  to="/_dashboard/search/"
                  className="text-sm text-bh-accent hover:underline flex items-center gap-1"
                >
                  Run <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent builders */}
      <div className="card">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-bh-text">Recent builders</h2>
          <Link
            to="/_dashboard/search/"
            className="text-sm text-bh-accent hover:underline flex items-center gap-1"
          >
            Search <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
        <p className="text-bh-text-muted text-sm py-8 text-center">
          No builders tracked yet.{' '}
          <Link to="/_dashboard/search/" className="text-bh-accent hover:underline">
            Run your first search
          </Link>
        </p>
      </div>
    </div>
  )
}
