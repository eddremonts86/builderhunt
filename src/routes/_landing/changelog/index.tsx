import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight, Tag, Calendar } from 'lucide-react'
import { Button } from '~/components/ui'
import { getSurfaceRobotsFn } from '~/shared/lib/seo/robots-data'
import { DEFAULT_DIRECTIVES, robotsMetaTag } from '~/shared/lib/seo/surfaces'

interface ChangelogEntry {
  id: string
  title: string
  content: string
  /** Server-rendered markdown (see src/routes/api/changelog/index.ts). */
  html?: string
  /** Plain-text projection of `content`, for the card excerpt. */
  excerpt?: string
  slug: string
  tags: string[]
  publishedAt: string
}

const TAG_COLORS: Record<string, string> = {
  feature: 'bg-bh-accent-soft text-bh-accent border-bh-accent/30',
  bugfix: 'bg-bh-warning/10 text-bh-warning border-bh-warning/30',
  breaking: 'bg-bh-danger/10 text-bh-danger border-bh-danger/30',
  improvement: 'bg-bh-cyan/10 text-bh-cyan-text border-bh-cyan/30',
}

export const Route = createFileRoute('/_landing/changelog/')({
  // Entries themselves are fetched client-side; this loader exists only so the
  // robots directive is in the server-rendered head, where a crawler reads it.
  loader: async () => ({ robots: await getSurfaceRobotsFn({ data: 'changelog' }) }),
  head: ({ loaderData }) => ({
    meta: [
      { title: 'Changelog — BuilderHunt' },
      {
        name: 'description',
        content: 'Everything we shipped, with the bugs we fixed and the claims we removed. Filter by feature, improvement, bugfix or breaking change.',
      },
      ...robotsMetaTag(loaderData?.robots ?? DEFAULT_DIRECTIVES),
    ],
  }),
  component: ChangelogPage,
})

function ChangelogPage() {
  const [entries, setEntries] = React.useState<ChangelogEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [activeTag, setActiveTag] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/changelog')
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        setEntries(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // Declaration order rather than first-seen order, so the filter row does not
  // reshuffle itself as entries are added.
  const tags = React.useMemo(() => {
    const present = new Set(entries.flatMap((e) => e.tags))
    const known = ['feature', 'improvement', 'bugfix', 'breaking'].filter((t) => present.has(t))
    const extra = [...present].filter((t) => !known.includes(t)).sort()
    return [...known, ...extra]
  }, [entries])

  const visible = activeTag ? entries.filter((e) => e.tags.includes(activeTag)) : entries

  return (
    <div className="min-h-[calc(100vh-4rem)] p-6 max-w-3xl mx-auto" data-testid="changelog-page">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Changelog</h1>
        <p className="text-bh-text-muted">
          What we shipped, what we fixed, and what we removed because we could not prove it.
        </p>
      </header>

      {tags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-6" data-testid="changelog-filters">
          <Button
            type="button"
            variant={activeTag === null ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActiveTag(null)}
            data-testid="changelog-filter-all"
          >
            All ({entries.length})
          </Button>
          {tags.map((t) => (
            <Button
              key={t}
              type="button"
              variant={activeTag === t ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setActiveTag(activeTag === t ? null : t)}
              data-testid={`changelog-filter-${t}`}
            >
              {t} ({entries.filter((e) => e.tags.includes(t)).length})
            </Button>
          ))}
        </div>
      )}

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
        {visible.map((entry) => (
          <article key={entry.id} className="card p-5" data-testid="changelog-entry">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
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
              {entry.excerpt ?? stripMarkdown(entry.content).slice(0, 240)}…
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

/** Fallback for a response that predates the API's `excerpt` field. */
function stripMarkdown(s: string): string {
  return s
    .replace(/^#+ .*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
}
