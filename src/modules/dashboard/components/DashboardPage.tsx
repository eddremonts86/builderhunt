import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Users, TrendingUp, Star, ExternalLink } from 'lucide-react'

export function DashboardPage() {
  const stats = [
    { label: 'Builders tracked', value: '0', icon: Users, color: 'text-bh-accent' },
    { label: 'Active this week', value: '0', icon: TrendingUp, color: 'text-green-400' },
    { label: 'GitHub stars earned', value: '0', icon: Star, color: 'text-yellow-400' },
  ]

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-bh-text mb-1">Dashboard</h1>
        <p className="text-bh-text-muted">Track and discover active builders</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-6 mb-10">
        {stats.map(({ label, value, icon: Icon, color }) => (
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