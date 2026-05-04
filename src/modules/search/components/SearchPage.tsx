import * as React from 'react'
import { Search, Code, ExternalLink } from 'lucide-react'
import { Input } from '~/components/ui'

interface Builder {
  id: string
  source: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  topics?: string[]
  score?: number
}

export function SearchPage() {
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<Builder[]>([])
  const [loading, setLoading] = React.useState(false)
  const [searched, setSearched] = React.useState(false)

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!query.trim()) return

    setLoading(true)
    setSearched(true)
    try {
      const res = await fetch('/api/search/builders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: query }),
      })
      const data = await res.json()
      setResults(data.builders ?? [])
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  const sourceBadge = (source: string) => {
    const cls = source === 'github' ? 'badge-github'
      : source === 'reddit' ? 'badge-reddit'
      : source === 'hn' ? 'badge-hn'
      : source === 'devto' ? 'badge-devto'
      : 'badge'
    return <span className={cls}>{source}</span>
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <h1 className="text-3xl font-bold text-bh-text mb-1">Search builders</h1>
      <p className="text-bh-text-muted mb-8">Find active builders by keyword across multiple platforms</p>

      {/* Search bar */}
      <form onSubmit={handleSearch} className="flex gap-3 mb-8">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bh-text-muted" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="e.g. react, rust, machine learning..."
            className="input-field pl-10"
          />
        </div>
        <button type="submit" disabled={loading} className="btn-primary">
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {/* Results */}
      {!searched ? (
        <div className="text-center py-20">
          <Search className="w-12 h-12 text-bh-border mx-auto mb-4" />
          <p className="text-bh-text-muted">Enter keywords to find builders</p>
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-bh-text-muted">No builders found. Try different keywords.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {results.map(builder => (
            <div key={`${builder.source}-${builder.id}`} className="card flex items-start gap-4">
              {builder.avatarUrl ? (
                <img
                  src={builder.avatarUrl}
                  alt={builder.username}
                  className="w-12 h-12 rounded-full border border-bh-border"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-bh-accent/20 flex items-center justify-center text-bh-accent text-sm font-medium">
                  {builder.username[0]?.toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-bh-text">{builder.displayName ?? builder.username}</span>
                  {sourceBadge(builder.source)}
                  {builder.topics?.slice(0, 3).map(t => (
                    <span key={t} className="badge">{t}</span>
                  ))}
                </div>
                <p className="text-sm text-bh-text-muted truncate">{builder.bio}</p>
                <div className="flex items-center gap-4 mt-2 text-xs text-bh-text-muted">
                  <a
                    href={builder.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-bh-accent hover:underline"
                  >
                    <Code className="w-3 h-3" /> {builder.username}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  {builder.followersCount != null && (
                    <span>{builder.followersCount.toLocaleString()} followers</span>
                  )}
                </div>
              </div>
              {builder.score != null && (
                <div className="text-right">
                  <span className="text-2xl font-bold text-bh-accent">{Math.round(builder.score)}</span>
                  <span className="text-xs text-bh-text-muted block">score</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}