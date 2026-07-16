import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, Calendar, Tag } from 'lucide-react'

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

export const Route = createFileRoute('/changelog/$slug')({
  component: ChangelogDetail,
})

function ChangelogDetail() {
  const { slug } = Route.useParams()
  const [entry, setEntry] = React.useState<ChangelogEntry | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)

  React.useEffect(() => {
    fetch(`/api/changelog`)
      .then((r) => r.ok ? r.json() : [])
      .then((list: ChangelogEntry[]) => {
        const found = list.find((e) => e.slug === slug)
        if (found) setEntry(found)
        else setNotFound(true)
        setLoading(false)
      })
      .catch(() => setNotFound(true))
  }, [slug])

  if (loading) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="animate-pulse h-8 w-3/4 bg-bh-surface rounded mb-4" />
        <div className="animate-pulse h-4 w-1/2 bg-bh-surface rounded mb-8" />
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="animate-pulse h-4 bg-bh-surface/40 rounded" />
          ))}
        </div>
      </div>
    )
  }

  if (notFound || !entry) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center">
        <h1 className="text-2xl font-bold mb-2">Entry not found</h1>
        <p className="text-bh-text-muted mb-4">No changelog entry with slug "{slug}".</p>
        <Link to="/changelog" className="btn-secondary inline-flex">Back to changelog</Link>
      </div>
    )
  }

  return (
    <article className="p-8 max-w-3xl mx-auto">
      <Link to="/changelog" className="btn-ghost btn-sm mb-6 inline-flex">
        <ArrowLeft className="w-3.5 h-3.5" /> All changelog
      </Link>

      <header className="mb-8">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {entry.tags.map((t) => (
            <span key={t} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${TAG_COLORS[t] ?? 'badge'}`}>
              <Tag className="w-2.5 h-2.5" /> {t}
            </span>
          ))}
          <span className="text-xs text-bh-text-dim ml-auto flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            {new Date(entry.publishedAt).toLocaleDateString()}
          </span>
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{entry.title}</h1>
      </header>

      <div className="prose prose-invert max-w-none text-bh-text-muted leading-relaxed whitespace-pre-wrap">
        {entry.content}
      </div>
    </article>
  )
}
