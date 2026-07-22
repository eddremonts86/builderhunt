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
  const sourceCounts = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const b of builders ?? []) map.set(b.source, (map.get(b.source) ?? 0) + 1)
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [builders])

  return (
    <div>
      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        <div className="w-11 h-11 rounded-xl bg-bh-accent-soft flex items-center justify-center shrink-0">
          <Download className="w-5 h-5 text-bh-accent" />
        </div>
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-bh-text mb-1">Exports</h1>
          <p className="text-bh-text-muted text-sm md:text-base">
            Builders you've tracked from search, in one place — download the list as a CSV whenever you want.
          </p>
        </div>
      </div>

      {error && (
        <div className="glass-panel mb-6 border-bh-danger/30 bg-bh-danger/5">
          <p className="text-sm text-bh-danger">{error}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-3 animate-pulse">
          <div className="h-20 bg-bh-surface/50 rounded-3xl" />
          {[...Array(3)].map((_, i) => (
            <div key={i} className="glass-panel h-16 bg-bh-surface/50" />
          ))}
        </div>
      )}

      {!loading && count === 0 && !error && (
        <div className="glass-panel text-center py-14">
          <div className="w-12 h-12 rounded-xl bg-bh-accent-soft flex items-center justify-center mx-auto mb-4">
            <Bookmark className="w-6 h-6 text-bh-accent" />
          </div>
          <p className="font-semibold text-bh-text mb-1">No tracked builders yet</p>
          <p className="text-sm text-bh-text-muted max-w-sm mx-auto mb-5">
            Search for builders and click "Track" on the ones you want to keep — they'll show up here, ready to export.
          </p>
          <LinkComponent to="/search" className="btn-primary btn-sm inline-flex items-center gap-2">
            <Search className="w-4 h-4" /> Track your first builder
          </LinkComponent>
        </div>
      )}

      {!loading && count > 0 && (
        <>
          {/* Toolbar: count + source mix + primary export action, all in one place */}
          <div className="glass-panel mb-5 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
            <div className="flex-1 min-w-0">
              <p className="text-2xl font-bold text-bh-text leading-none mb-1.5">
                {count} <span className="text-base font-medium text-bh-text-muted">builder{count === 1 ? '' : 's'} tracked</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sourceCounts.map(([source, n]) => (
                  <span key={source} className={`badge badge-${source}`}>
                    {source} · {n}
                  </span>
                ))}
              </div>
            </div>
            <div className="sm:text-right shrink-0">
              {downloadMsg && <p className="text-sm mb-2 text-bh-danger">{downloadMsg}</p>}
              <button
                onClick={handleDownload}
                disabled={downloading}
                className="btn-primary w-full sm:w-auto flex items-center justify-center gap-2"
              >
                {downloading ? <span className="spinner" /> : <Download className="w-4 h-4" />}
                {downloading ? 'Preparing...' : 'Download CSV'}
              </button>
            </div>
          </div>

          <ul className="space-y-2" role="list">
            {builders!.map((b) => (
              <li
                key={b.id}
                className="glass-panel card-hover p-3 flex items-center gap-3"
                data-testid={`tracked-builder-${b.id}`}
              >
                {b.avatarUrl ? (
                  <img src={b.avatarUrl} alt="" loading="lazy" className="w-9 h-9 rounded-full shrink-0 object-cover bg-bh-surface" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-bh-surface flex items-center justify-center text-sm font-semibold text-bh-text shrink-0">
                    {(b.displayName ?? b.username)[0]?.toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-bh-text truncate">{b.displayName ?? b.username}</p>
                  <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                    <span className={`badge badge-${b.source} text-[10px] px-1.5 py-0 shrink-0`}>{b.source}</span>
                    <p className="text-xs text-bh-text-muted truncate">
                      @{b.username}
                      {b.topics.length > 0 && ` · ${b.topics.slice(0, 3).join(', ')}`}
                    </p>
                  </div>
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
                  className="btn-ghost btn-sm shrink-0 text-bh-danger"
                  title="Remove from tracked builders"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-xs text-bh-text-dim mt-8 text-center">
        Looking to export <em>all your BuilderHunt account data</em> (profile, saved searches, notes) instead? That's a
        different, GDPR-focused export on{' '}
        <LinkComponent to="/settings/privacy" className="text-bh-accent hover:underline">
          Settings → Privacy
        </LinkComponent>.
      </p>
    </div>
  )
}
