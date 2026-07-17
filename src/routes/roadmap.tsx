import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { CheckCircle2, Circle, Loader2, ArrowUp, Calendar } from 'lucide-react'

interface RoadmapItem {
  id: string
  title: string
  description: string | null
  status: 'planned' | 'in_progress' | 'shipped'
  shipEstimate: string | null
  category: string | null
  voteCount: number
  userHasVoted: boolean
}

const COLUMNS: Array<{ key: RoadmapItem['status']; label: string; icon: typeof Circle }> = [
  { key: 'planned', label: 'Planned', icon: Circle },
  { key: 'in_progress', label: 'In progress', icon: Loader2 },
  { key: 'shipped', label: 'Shipped', icon: CheckCircle2 },
]

export const Route = createFileRoute('/roadmap')({
  component: RoadmapPage,
})

function RoadmapPage() {
  const [items, setItems] = React.useState<RoadmapItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [voting, setVoting] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/roadmap', { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setItems(Array.isArray(data) ? data : [])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const vote = async (itemId: string) => {
    setVoting(itemId)
    try {
      await fetch('/api/roadmap', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
      })
      await load()
    } finally {
      setVoting(null)
    }
  }

  const grouped = COLUMNS.map((col) => ({
    ...col,
    items: items.filter((i) => i.status === col.key),
  }))

  return (
    <div className="min-h-[calc(100vh-4rem)] p-6 max-w-6xl mx-auto">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Roadmap</h1>
        <p className="text-bh-text-muted">What we're building. Vote on what matters most to you.</p>
      </header>

      {loading ? (
        <div className="text-center py-12 text-bh-text-muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-bh-text-muted">No roadmap items yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {grouped.map((col) => (
            <div key={col.key} className="space-y-3">
              <div className="flex items-center gap-2 px-1">
                <col.icon
                  className={`w-4 h-4 ${
                    col.key === 'shipped' ? 'text-bh-success' :
                    col.key === 'in_progress' ? 'text-bh-warning animate-spin' :
                    'text-bh-text-dim'
                  }`}
                  aria-hidden="true"
                />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-bh-text-dim">
                  {col.label}
                </h2>
                <span className="text-xs text-bh-text-dim">({col.items.length})</span>
              </div>
              {col.items.map((item) => (
                <article
                  key={item.id}
                  className="card p-4"
                  data-testid={`roadmap-item-${item.id}`}
                >
                  <div className="flex items-start gap-2 mb-2">
                    <h3 className="font-semibold text-sm text-bh-text flex-1">
                      {item.title}
                    </h3>
                  </div>
                  {item.description && (
                    <p className="text-xs text-bh-text-muted mb-3 line-clamp-2">
                      {item.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-xs">
                    {item.shipEstimate && (
                      <span className="inline-flex items-center gap-1 text-bh-text-dim">
                        <Calendar className="w-3 h-3" />
                        {item.shipEstimate}
                      </span>
                    )}
                    {col.key !== 'shipped' && (
                      <button
                        type="button"
                        onClick={() => vote(item.id)}
                        disabled={voting === item.id}
                        className={`btn-sm ml-auto ${
                          item.userHasVoted ? 'btn-primary' : 'btn-secondary'
                        }`}
                        data-testid="roadmap-vote-btn"
                        data-item-id={item.id}
                      >
                        <ArrowUp className="w-3 h-3" aria-hidden="true" />
                        {item.voteCount}
                      </button>
                    )}
                    {col.key === 'shipped' && (
                      <span className="ml-auto text-xs text-bh-success">
                        +{item.voteCount} wanted
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-bh-text-dim mt-8 text-center">
        Want to suggest something?{' '}
        <a href="mailto:hello@builderhunt.dev" className="text-bh-accent hover:underline">
          Email us
        </a>
        .
      </p>
    </div>
  )
}
