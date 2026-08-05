import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { CheckCircle2, Circle, Loader2, ArrowUp, Calendar } from 'lucide-react'
import { Button } from '~/components/ui'
import { getSurfaceRobotsFn } from '~/shared/lib/seo/robots-data'
import { DEFAULT_DIRECTIVES, robotsMetaTag } from '~/shared/lib/seo/surfaces'
import { pageMeta } from '~/shared/lib/page-meta'

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

export const Route = createFileRoute('/_landing/roadmap')({
  // Items and votes are fetched client-side; the loader exists so the robots
  // directive lands in the server-rendered head.
  loader: async () => ({ robots: await getSurfaceRobotsFn({ data: 'roadmap' }) }),
  head: ({ loaderData }) => ({
    meta: [
      ...pageMeta({
        title: 'Roadmap — BuilderHunt',
        description: 'What we are building, what is in progress, and what already shipped. Vote on what matters most to you.',
      }),
      ...robotsMetaTag(loaderData?.robots ?? DEFAULT_DIRECTIVES),
    ],
  }),
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
    <div className="container py-12 max-w-6xl animate-fade-in" data-testid="roadmap-page">
      <header className="mb-10">
        <h1 className="text-4xl font-extrabold tracking-tight mb-2 text-bh-text">Roadmap</h1>
        <p className="text-bh-text-muted text-base">What we are building. Vote on what matters most to you.</p>
      </header>

      {loading ? (
        <div className="text-center py-12 text-bh-text-muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card text-center py-12 border border-bh-border/60 bg-bh-surface rounded-2xl">
          <p className="text-bh-text-muted">No roadmap items yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {grouped.map((col) => (
            <div key={col.key} className="space-y-4">
              <div className="flex items-center gap-2 px-1 pb-2 border-b border-bh-border/40">
                <col.icon
                  className={`w-4 h-4 ${
                    col.key === 'shipped' ? 'text-bh-success' :
                    col.key === 'in_progress' ? 'text-bh-warning animate-spin' :
                    'text-bh-text-dim'
                  }`}
                  aria-hidden="true"
                />
                <h2 className="text-xs font-bold uppercase tracking-wider text-bh-text-dim">
                  {col.label}
                </h2>
                <span className="text-xs text-bh-text-dim">({col.items.length})</span>
              </div>
              {col.items.map((item) => (
                <article
                  key={item.id}
                  className="card p-5 border border-bh-border/60 bg-bh-surface rounded-xl hover:border-bh-accent/30 transition-all shadow-sm flex flex-col justify-between"
                  data-testid={`roadmap-item-${item.id}`}
                >
                  <div className="flex items-start gap-2 mb-2">
                    <h3 className="font-bold text-sm text-bh-text flex-1">
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
                      <Button
                        type="button"
                        onClick={() => vote(item.id)}
                        disabled={voting === item.id}
                        variant={item.userHasVoted ? 'primary' : 'secondary'}
                        size="sm"
                        className="ml-auto"
                        data-testid="roadmap-vote-btn"
                        data-item-id={item.id}
                      >
                        <ArrowUp className="w-3 h-3" aria-hidden="true" />
                        {item.voteCount}
                      </Button>
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
