import * as React from 'react'
import { useParams, Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Code, Save } from 'lucide-react'

interface Builder {
  id: string
  source: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  country?: string
  topics?: string[]
  metadata?: Record<string, unknown>
  score?: number
}

interface Note {
  id: string
  content: string
  createdAt: string
}

export function BuilderProfilePage() {
  const { builderId } = useParams()
  const [builder, setBuilder] = React.useState<Builder | null>(null)
  const [notes, setNotes] = React.useState<Note[]>([])
  const [loading, setLoading] = React.useState(true)
  const [noteText, setNoteText] = React.useState('')
  const [savingNote, setSavingNote] = React.useState(false)

  React.useEffect(() => {
    if (!builderId) return
    Promise.all([
      fetch(`/api/builders/${builderId}`, { credentials: 'include' }).then(r => r.json()),
      fetch(`/api/builders/${builderId}/notes`, { credentials: 'include' }).then(r => r.json()),
    ]).then(([b, n]) => {
      setBuilder(b)
      setNotes(Array.isArray(n) ? n : [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [builderId])

  const handleSaveNote = async () => {
    if (!noteText.trim()) return
    setSavingNote(true)
    try {
      const res = await fetch(`/api/builders/${builderId}/notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteText }),
      })
      if (res.ok) {
        const newNote = await res.json()
        setNotes(prev => [...prev, newNote])
        setNoteText('')
      }
    } finally {
      setSavingNote(false)
    }
  }

  const score = builder?.metadata && typeof builder.metadata === 'object'
    ? (builder.metadata as Record<string, unknown>).score as number ?? 0
    : 0

  const scorePercent = Math.min(score, 100)

  const sourceBadge = (source: string) => {
    const cls = source === 'github' ? 'badge-github'
      : source === 'reddit' ? 'badge-reddit'
      : source === 'hn' ? 'badge-hn'
      : source === 'devto' ? 'badge-devto'
      : 'badge'
    return <span className={cls}>{source}</span>
  }

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-bh-text-muted">Loading...</p>
      </div>
    )
  }

  if (!builder) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Link
          to="/_dashboard/search/"
          className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to search
        </Link>
        <div className="card">
          <p className="text-bh-text-muted">Builder not found</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link
        to="/_dashboard/search/"
        className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to search
      </Link>

      <div className="card mb-6">
        <div className="flex items-start gap-5">
          {builder.avatarUrl ? (
            <img
              src={builder.avatarUrl}
              alt={builder.username}
              className="w-20 h-20 rounded-full border border-bh-border"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-bh-accent/20 flex items-center justify-center text-bh-accent text-2xl font-medium">
              {builder.username[0]?.toUpperCase()}
            </div>
          )}

          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-bh-text">
                {builder.displayName ?? builder.username}
              </h1>
              {sourceBadge(builder.source)}
            </div>

            {builder.bio && (
              <p className="text-bh-text-muted mb-3">{builder.bio}</p>
            )}

            <div className="flex items-center gap-4 text-sm text-bh-text-muted mb-4">
              {builder.country && <span>{builder.country}</span>}
              {builder.language && <span>{builder.language}</span>}
              {builder.followersCount != null && (
                <span>{builder.followersCount.toLocaleString()} followers</span>
              )}
            </div>

            {builder.topics?.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {builder.topics.map(t => (
                  <span key={t} className="badge">{t}</span>
                ))}
              </div>
            )}

            <a
              href={builder.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-bh-accent hover:underline"
            >
              <Code className="w-4 h-4" />
              {builder.username} <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Score circle */}
          <div className="flex flex-col items-center">
            <div className="relative w-20 h-20">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--bh-border)" strokeWidth="3" />
                <circle
                  cx="18" cy="18" r="15.9" fill="none"
                  stroke="var(--bh-accent)" strokeWidth="3"
                  strokeDasharray={`${scorePercent}, 100`}
                  strokeDashoffset="25"
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xl font-bold text-bh-text">{Math.round(score)}</span>
              </div>
            </div>
            <span className="text-xs text-bh-text-muted mt-1">score</span>
          </div>
        </div>
      </div>

      {/* Notes section */}
      <div className="card">
        <h2 className="text-lg font-semibold text-bh-text mb-4">Notes</h2>

        {notes.length > 0 ? (
          <div className="space-y-3 mb-4">
            {notes.map(note => (
              <div key={note.id} className="bg-bh-bg-alt border border-bh-border rounded-lg p-3">
                <p className="text-sm text-bh-text">{note.content}</p>
                <p className="text-xs text-bh-text-muted mt-1">
                  {new Date(note.createdAt).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-bh-text-muted mb-4">No notes yet.</p>
        )}

        <div className="flex gap-2">
          <textarea
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="Add a note about this builder..."
            className="input-field flex-1 resize-none"
            rows={2}
          />
          <button
            onClick={handleSaveNote}
            disabled={savingNote || !noteText.trim()}
            className="btn-primary flex items-center gap-2 h-fit"
          >
            <Save className="w-4 h-4" />
            {savingNote ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
