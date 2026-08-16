/**
 * Per-surface search-engine indexing switches.
 *
 * Blog, changelog and roadmap ship `noindex, nofollow` and can be opened up one
 * at a time, at any moment, without a deploy. Flipping a switch here changes
 * three things at once — the page's robots meta tag, the surface's line in
 * `robots.txt`, and whether its URLs appear in `sitemap.xml` — because a page
 * that says one thing in its head and another in robots.txt is worse than
 * either instruction alone.
 */
import * as React from 'react'
import { Eye, EyeOff, Link2Off, Search } from 'lucide-react'
import { Switch } from '~/components/ui'
import { SEO_SURFACE_DEFINITIONS, type SeoSurface } from '~/shared/lib/seo/surfaces'

export interface SurfaceIndexingRow {
  surface: SeoSurface
  noindex: boolean
  nofollow: boolean
  updatedAt: string | null
  updatedBy: string | null
  persisted: boolean
}

export function IndexingPanel() {
  const [rows, setRows] = React.useState<SurfaceIndexingRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState<SeoSurface | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/seo', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data = await res.json()
      setRows(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const update = async (row: SurfaceIndexingRow, patch: Partial<Pick<SurfaceIndexingRow, 'noindex' | 'nofollow'>>) => {
    setSaving(row.surface)
    setError(null)
    // Optimistic: a switch that lags behind the click reads as broken. Reverted
    // by the reload below if the request failed.
    setRows((current) => current.map((r) => (r.surface === row.surface ? { ...r, ...patch } : r)))
    try {
      const res = await fetch('/api/admin/seo', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surface: row.surface,
          noindex: patch.noindex ?? row.noindex,
          nofollow: patch.nofollow ?? row.nofollow,
        }),
      })
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(null)
      await load()
    }
  }

  return (
    <section className="card p-5 border-bh-border/60" data-testid="admin-indexing-panel">
      <header className="mb-1 flex items-center gap-2">
        <Search className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        <h2 className="font-semibold text-sm">Search indexing</h2>
      </header>
      <p className="text-xs text-bh-text-muted leading-relaxed mb-4">
        Each surface can be hidden from search engines independently, and changed back at any time —
        no deploy. A change takes effect on the next request: it drives the page&apos;s{' '}
        <code className="text-bh-accent">robots</code> meta tag, the surface&apos;s line in{' '}
        <a href="/robots.txt" className="text-bh-accent underline" target="_blank" rel="noreferrer">robots.txt</a>,
        and whether its URLs appear in{' '}
        <a href="/sitemap.xml" className="text-bh-accent underline" target="_blank" rel="noreferrer">sitemap.xml</a>.
      </p>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-bh-text-muted">Loading…</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const definition = SEO_SURFACE_DEFINITIONS[row.surface]
            const hidden = row.noindex
            return (
              <div
                key={row.surface}
                className="rounded-xl border border-bh-border/50 p-4 flex flex-col md:flex-row md:items-center gap-4"
                data-testid={`admin-indexing-row-${row.surface}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm flex items-center gap-2">
                    {hidden ? (
                      <EyeOff className="w-3.5 h-3.5 text-bh-warning" aria-hidden="true" />
                    ) : (
                      <Eye className="w-3.5 h-3.5 text-bh-success" aria-hidden="true" />
                    )}
                    {definition?.label ?? row.surface}
                    <span
                      className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded border ${
                        hidden
                          ? 'border-bh-warning/30 bg-bh-warning/10 text-bh-warning'
                          : 'border-bh-success/30 bg-bh-success/10 text-bh-success'
                      }`}
                      data-testid={`admin-indexing-status-${row.surface}`}
                    >
                      {hidden ? 'hidden' : 'indexable'}
                    </span>
                  </p>
                  <p className="text-xs text-bh-text-muted mt-1">{definition?.scope}</p>
                  <p className="text-xs text-bh-text-dim mt-1">
                    {definition?.paths.join(', ')}
                    {row.updatedAt
                      ? ` · changed ${new Date(row.updatedAt).toLocaleString()}`
                      : ' · never changed (default)'}
                  </p>
                </div>

                <div className="flex items-center gap-6 shrink-0">
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Switch
                      checked={row.noindex}
                      onCheckedChange={(checked) => update(row, { noindex: checked })}
                      disabled={saving === row.surface}
                      aria-label={`noindex for ${definition?.label ?? row.surface}`}
                      data-testid={`admin-indexing-noindex-${row.surface}`}
                    />
                    <span className="inline-flex items-center gap-1 font-mono">
                      <EyeOff className="w-3 h-3" aria-hidden="true" />
                      noindex
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Switch
                      checked={row.nofollow}
                      onCheckedChange={(checked) => update(row, { nofollow: checked })}
                      disabled={saving === row.surface}
                      aria-label={`nofollow for ${definition?.label ?? row.surface}`}
                      data-testid={`admin-indexing-nofollow-${row.surface}`}
                    />
                    <span className="inline-flex items-center gap-1 font-mono">
                      <Link2Off className="w-3 h-3" aria-hidden="true" />
                      nofollow
                    </span>
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-xs text-bh-text-dim mt-4">
        Both off means the page carries no robots tag at all, which is the same instruction as
        <code> index, follow</code>. Turning <code>noindex</code> back on does not remove a page that
        is already indexed overnight — search engines need to re-crawl it first.
      </p>
    </section>
  )
}
