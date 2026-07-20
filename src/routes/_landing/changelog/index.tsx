import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight, Tag, Calendar } from 'lucide-react'

interface ChangelogEntry {
  id: string
  title: string
  content: string
  slug: string
  tags: string[]
  publishedAt: string
}

const TAG_COLORS: Record<string, string> = {
  feature: 'bg-bh-accent-soft text-bh-accent border-bh-accent/30',
  bugfix: 'bg-bh-warning/10 text-bh-warning border-bh-warning/30',
  breaking: 'bg-bh-danger/10 text-bh-danger border-bh-danger/30',
  improvement: 'bg-bh-cyan/10 text-bh-cyan border-bh-cyan/30',
}

export const Route = createFileRoute('/_landing/changelog/')({
  component: ChangelogPage,
})

function ChangelogPage() {
  const [entries, setEntries] = React.useState<ChangelogEntry[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    fetch('/api/changelog')
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        setEntries(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-[calc(100vh-4rem)] p-6 max-w-3xl mx-auto">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Changelog</h1>
        <p className="text-bh-text-muted">What we shipped, week by week.</p>
      </header>

      {loading && (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card animate-pulse h-32" />
          ))}
        </div>
      )}

      {!loading && entries.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-bh-text-muted">No changelog entries yet.</p>
        </div>
      )}

      <div className="space-y-4">
        {entries.map((entry) => (
          <article key={entry.id} className="card p-5" data-testid="changelog-entry">
            <div className="flex items-center gap-2 mb-2">
              {entry.tags.map((t) => (
                <span
                  key={t}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${TAG_COLORS[t] ?? 'badge'}`}
                >
                  <Tag className="w-2.5 h-2.5" />
                  {t}
                </span>
              ))}
              <span className="text-xs text-bh-text-dim ml-auto flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {new Date(entry.publishedAt).toLocaleDateString()}
              </span>
            </div>
            <h2 className="text-lg font-semibold text-bh-text mb-2">{entry.title}</h2>
            <p className="text-sm text-bh-text-muted line-clamp-3 mb-3">
              {stripMarkdown(entry.content).slice(0, 200)}…
            </p>
            <Link
              to="/changelog/$slug"
              params={{ slug: entry.slug }}
              className="text-sm text-bh-accent hover:underline inline-flex items-center gap-1"
              data-testid="changelog-read-more"
            >
              Read more
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </article>
        ))}
      </div>
    </div>
  )
}

function stripMarkdown(s: string): string {
  return s
    .replace(/^#+ .*$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
}
