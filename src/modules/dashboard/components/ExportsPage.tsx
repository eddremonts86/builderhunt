import * as React from 'react'
import { Download, Bookmark, Trash2, ExternalLink, Search } from 'lucide-react'
import { LinkComponent, ScoreRing } from '~/components/ui'

interface TrackedBuilder {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  source: string
  profileUrl: string
  topics: string[]
  score: number | null
  lastSeen: string | null
}

export function ExportsPage() {
  const [builders, setBuilders] = React.useState<TrackedBuilder[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const [downloading, setDownloading] = React.useState(false)
  const [downloadMsg, setDownloadMsg] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/me/builders', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: TrackedBuilder[]) => setBuilders(data))
      .catch(() => setError('Failed to load your tracked builders.'))
  }, [])

  const handleRemove = async (id: string) => {
    setRemovingId(id)
    try {
      const res = await fetch(`/api/builders/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setBuilders((prev) => (prev ? prev.filter((b) => b.id !== id) : prev))
    } catch {
      setError('Failed to remove that builder. Please try again.')
    } finally {
      setRemovingId(null)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    setDownloadMsg(null)
    try {
      const res = await fetch('/api/export/builders', { credentials: 'include' })
      if (!res.ok) {
        setDownloadMsg('Please sign in to download your builders.')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'builders.csv'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setDownloadMsg('Download failed. Please try again.')
    } finally {
      setDownloading(false)
    }
  }

  const loading = builders === null && !error
  const count = builders?.length ?? 0

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-bh-text mb-1">Exports</h1>
      <p className="text-bh-text-muted mb-2">
        Builders you've tracked from search, in one place — download the list as a CSV whenever you want.
      </p>
      <p className="text-sm text-bh-text-dim mb-8">
        Looking to export <em>all your BuilderHunt account data</em> (profile, saved searches, notes) instead?
        That's a different, GDPR-focused export on{' '}
        <LinkComponent to="/settings/privacy" className="text-bh-accent hover:underline">
          Settings → Privacy
        </LinkComponent>.
      </p>

      {error && (
        <div className="card mb-6 border-red-500/30 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-3 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card h-16 bg-bh-surface/50" />
          ))}
        </div>
      )}

      {!loading && count === 0 && !error && (
        <div className="card text-center py-12">
          <div className="w-12 h-12 rounded-xl bg-bh-accent/10 flex items-center justify-center mx-auto mb-4">
            <Bookmark className="w-6 h-6 text-bh-accent" />
          </div>
          <p className="font-semibold text-bh-text mb-1">No tracked builders yet</p>
          <p className="text-sm text-bh-text-muted max-w-sm mx-auto mb-4">
            Search for builders and click "Track" on the ones you want to keep — they'll show up here, ready to export.
          </p>
          <LinkComponent to="/search" className="btn-primary btn-sm inline-flex items-center gap-2">
            <Search className="w-4 h-4" /> Track your first builder
          </LinkComponent>
        </div>
      )}

      {!loading && count > 0 && (
        <>
          <p className="text-sm text-bh-text-muted mb-3">
            {count} builder{count === 1 ? '' : 's'} tracked
          </p>
          <ul className="space-y-2 mb-6" role="list">
            {builders!.map((b) => (
              <li key={b.id} className="card p-3 flex items-center gap-3" data-testid={`tracked-builder-${b.id}`}>
                {b.avatarUrl ? (
                  <img src={b.avatarUrl} alt="" loading="lazy" className="w-9 h-9 rounded-full shrink-0 object-cover bg-bh-surface" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-bh-surface flex items-center justify-center text-sm font-semibold text-bh-text shrink-0">
                    {(b.displayName ?? b.username)[0]?.toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-bh-text truncate">{b.displayName ?? b.username}</p>
                  <p className="text-xs text-bh-text-muted truncate">
                    @{b.username} · {b.source}
                    {b.topics.length > 0 && ` · ${b.topics.slice(0, 3).join(', ')}`}
                  </p>
                </div>
                {b.score != null && <ScoreRing score={b.score} size={32} showLabel={false} />}
                <a
                  href={b.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-ghost btn-sm shrink-0"
                  title="Open profile"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button
                  type="button"
                  onClick={() => handleRemove(b.id)}
                  disabled={removingId === b.id}
                  className="btn-ghost btn-sm shrink-0 text-red-400"
                  title="Remove from tracked builders"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="card max-w-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 rounded-xl bg-bh-accent/10">
            <Download className="w-6 h-6 text-bh-accent" />
          </div>
          <div>
            <p className="font-medium text-bh-text">Export all builders</p>
            <p className="text-sm text-bh-text-muted">Download as CSV</p>
          </div>
        </div>

        {downloadMsg && <p className="text-sm mb-4 text-red-400">{downloadMsg}</p>}

        <button
          onClick={handleDownload}
          disabled={downloading || count === 0}
          title={count === 0 ? 'Track at least one builder first' : undefined}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Download className="w-4 h-4" />
          {downloading ? 'Preparing...' : 'Download CSV'}
        </button>
      </div>
    </div>
  )
}
