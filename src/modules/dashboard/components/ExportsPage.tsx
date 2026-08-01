import * as React from 'react'
import { Download, Bookmark, Trash2, ExternalLink, Search } from 'lucide-react'
import { Button, LinkButton, LinkComponent, ScoreRing, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui'
import { StyleMatchPanel } from '~/modules/dashboard/components/StyleMatchPanel'
import { EXPORT_FORMATS, EXPORT_SCOPE_DEFINITIONS, EXPORT_SCOPES, type ExportFormat, type ExportScope } from '~/shared/lib/exports/capability-registry'

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

interface NamedResource {
  id: string
  name: string
}

export function ExportsPage() {
  const [builders, setBuilders] = React.useState<TrackedBuilder[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const [downloading, setDownloading] = React.useState(false)
  const [downloadMsg, setDownloadMsg] = React.useState<string | null>(null)
  const [scope, setScope] = React.useState<ExportScope>('all')
  const [format, setFormat] = React.useState<ExportFormat>('csv')
  const [listId, setListId] = React.useState<string | null>(null)
  const [savedQueryId, setSavedQueryId] = React.useState<string | null>(null)
  const [lists, setLists] = React.useState<NamedResource[] | null>(null)
  const [savedQueries, setSavedQueries] = React.useState<NamedResource[] | null>(null)

  React.useEffect(() => {
    fetch('/api/me/builders', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: TrackedBuilder[]) => setBuilders(data))
      .catch(() => setError('Failed to load your tracked builders.'))
  }, [])

  // Loaded once, lazily — most visitors export "all tracked" and never open these pickers.
  React.useEffect(() => {
    if (scope === 'list' && lists === null) {
      fetch('/api/lists', { credentials: 'include' })
        .then((res) => (res.ok ? res.json() : []))
        .then((data: NamedResource[]) => {
          setLists(data)
          if (data.length > 0 && !listId) setListId(data[0].id)
        })
        .catch(() => setLists([]))
    }
    if (scope === 'saved-search' && savedQueries === null) {
      fetch('/api/queries', { credentials: 'include' })
        .then((res) => (res.ok ? res.json() : []))
        .then((data: NamedResource[]) => {
          setSavedQueries(data)
          if (data.length > 0 && !savedQueryId) setSavedQueryId(data[0].id)
        })
        .catch(() => setSavedQueries([]))
    }
  }, [scope, lists, savedQueries, listId, savedQueryId])

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
    if (scope === 'list' && !listId) {
      setDownloadMsg('Choose a shortlist to export.')
      return
    }
    if (scope === 'saved-search' && !savedQueryId) {
      setDownloadMsg('Choose a saved search to export.')
      return
    }
    setDownloading(true)
    setDownloadMsg(null)
    try {
      const params = new URLSearchParams({ scope, format })
      if (scope === 'list' && listId) params.set('listId', listId)
      if (scope === 'saved-search' && savedQueryId) params.set('savedQueryId', savedQueryId)
      const res = await fetch(`/api/export/builders?${params}`, { credentials: 'include' })
      if (!res.ok) {
        if (res.status === 404) {
          setDownloadMsg("That shortlist or saved search isn't visible to you — it may have been deleted or belongs to someone else.")
        } else if (res.status === 401) {
          setDownloadMsg('Please sign in to download your builders.')
        } else if (res.status === 429) {
          setDownloadMsg('Daily export limit reached for this seat. Try again tomorrow.')
        } else {
          setDownloadMsg('Download failed. Please try again.')
        }
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `builders-${scope}.${format}`
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
            Export all tracked builders, one shortlist, one saved search's results, or your noted builders — as CSV or JSON.
          </p>
        </div>
      </div>

      {error && (
        <div className="card mb-6 border-bh-danger/30 bg-bh-danger/5">
          <p className="text-sm text-bh-danger">{error}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-3 animate-pulse">
          <div className="h-20 bg-bh-surface/50 rounded-3xl" />
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card h-16 bg-bh-surface/50" />
          ))}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Export Center (plans/UI/tasks.md Wave 6 "Build a scoped Export Center") — every
              scope/format combination this card offers is real; see
              ~/shared/lib/exports/capability-registry.ts. Available regardless of tracked-builder
              count: a saved-search or notes export doesn't depend on "all tracked" being non-empty. */}
          <div className="card mb-5 space-y-4" data-testid="export-center">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1 min-w-0">
                <label className="text-xs font-medium text-bh-text-dim block mb-1" htmlFor="export-scope">Scope</label>
                <Select value={scope} onValueChange={(v) => setScope(v as ExportScope)}>
                  <SelectTrigger id="export-scope" data-testid="export-scope-select"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXPORT_SCOPES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s === 'all' ? 'All tracked builders' : EXPORT_SCOPE_DEFINITIONS[s].label.replace(/^./, (c) => c.toUpperCase())}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {scope === 'list' && (
                <div className="flex-1 min-w-0">
                  <label className="text-xs font-medium text-bh-text-dim block mb-1" htmlFor="export-list">Shortlist</label>
                  {lists === null ? (
                    <p className="text-sm text-bh-text-muted py-2">Loading shortlists…</p>
                  ) : lists.length === 0 ? (
                    <p className="text-sm text-bh-text-muted py-2">No shortlists yet.</p>
                  ) : (
                    <Select value={listId ?? undefined} onValueChange={setListId}>
                      <SelectTrigger id="export-list" data-testid="export-list-select"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {lists.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {scope === 'saved-search' && (
                <div className="flex-1 min-w-0">
                  <label className="text-xs font-medium text-bh-text-dim block mb-1" htmlFor="export-saved-search">Saved search</label>
                  {savedQueries === null ? (
                    <p className="text-sm text-bh-text-muted py-2">Loading saved searches…</p>
                  ) : savedQueries.length === 0 ? (
                    <p className="text-sm text-bh-text-muted py-2">No saved searches yet.</p>
                  ) : (
                    <Select value={savedQueryId ?? undefined} onValueChange={setSavedQueryId}>
                      <SelectTrigger id="export-saved-search" data-testid="export-saved-search-select"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {savedQueries.map((q) => <SelectItem key={q.id} value={q.id}>{q.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              <div className="w-full sm:w-32">
                <label className="text-xs font-medium text-bh-text-dim block mb-1" htmlFor="export-format">Format</label>
                <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                  <SelectTrigger id="export-format" data-testid="export-format-select"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {EXPORT_FORMATS.map((f) => <SelectItem key={f} value={f}>{f.toUpperCase()}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <Button
                variant="primary"
                onClick={handleDownload}
                disabled={downloading}
                className="w-full sm:w-auto flex items-center justify-center gap-2 shrink-0"
                data-testid="export-download-button"
              >
                {downloading ? <span className="spinner" /> : <Download className="w-4 h-4" />}
                {downloading ? 'Preparing...' : 'Download'}
              </Button>
            </div>

            {downloadMsg && <p className="text-sm text-bh-danger" data-testid="export-message">{downloadMsg}</p>}

            <p className="text-xs text-bh-text-dim">
              Exports only include what you can already see — a shortlist or saved search someone else marked private
              won't appear here, and every download is capped at a bounded number of rows.
            </p>
          </div>

          {count === 0 && (
            <div className="card text-center py-14">
              <div className="w-12 h-12 rounded-xl bg-bh-accent-soft flex items-center justify-center mx-auto mb-4">
                <Bookmark className="w-6 h-6 text-bh-accent" />
              </div>
              <p className="font-semibold text-bh-text mb-1">No tracked builders yet</p>
              <p className="text-sm text-bh-text-muted max-w-sm mx-auto mb-5">
                Search for builders and click "Track" on the ones you want to keep — they'll show up here, ready to export.
              </p>
              <LinkButton to="/search" variant="primary" size="sm" className="inline-flex items-center gap-2">
                <Search className="w-4 h-4" /> Track your first builder
              </LinkButton>
            </div>
          )}

          {count > 0 && (
            <>
              <div className="card mb-5 flex items-center gap-1.5 flex-wrap">
                <p className="text-sm font-medium text-bh-text-muted mr-2">
                  {count} builder{count === 1 ? '' : 's'} tracked:
                </p>
                {sourceCounts.map(([source, n]) => (
                  <span key={source} className={`badge badge-${source}`}>
                    {source} · {n}
                  </span>
                ))}
              </div>

              <ul className="space-y-2" role="list">
                {builders!.map((b) => (
              <li
                key={b.id}
                className="card card-hover p-3 flex items-center gap-3"
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
                  <LinkComponent
                    to="/builder/$builderId"
                    params={{ builderId: b.id }}
                    className="font-medium text-sm text-bh-text truncate hover:text-bh-accent hover:underline block"
                    data-testid={`tracked-builder-open-${b.id}`}
                  >
                    {b.displayName ?? b.username}
                  </LinkComponent>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(b.id)}
                  disabled={removingId === b.id}
                  className="shrink-0 text-bh-danger"
                  title="Remove from tracked builders"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </li>
            ))}
              </ul>
            </>
          )}
        </>
      )}

      {/* Style matching lives here rather than on a route of its own: it acts
          on the tracked-builder set this page is already about. It gates
          itself on fingerprint density (plan: code-fingerprinting Phase 4). */}
      <div className="mt-8">
        <StyleMatchPanel />
      </div>

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
