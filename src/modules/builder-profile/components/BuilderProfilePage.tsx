import * as React from 'react'
import { useParams, Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Code, Save, BadgeCheck, Sparkles, Users, Lock, FileText } from 'lucide-react'
import { HygieneCard } from '~/shared/components/HygieneCard'
import { CodeStyleCard } from '~/shared/components/CodeStyleCard'
import { OutreachCopilot } from '~/modules/builder-profile/components/OutreachCopilot'
import { PersonaCard } from '~/modules/builder-profile/components/PersonaCard'

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
  isClaimed?: boolean
  isVerified?: boolean
  claimedByUserId?: string | null
  claimedAt?: string | null
  openToStatus?: string[]
  claimedTopics?: string[]
}

interface Note {
  id: string
  content: string
  createdAt: string
}

export function BuilderProfilePage() {
  const params = useParams({ strict: false }) as { builderId?: string }
  const builderId = params.builderId
  const [builder, setBuilder] = React.useState<Builder | null>(null)
  const [notes, setNotes] = React.useState<Note[]>([])
  const [loading, setLoading] = React.useState(true)
  const [noteText, setNoteText] = React.useState('')
  const [savingNote, setSavingNote] = React.useState(false)
  const [meId, setMeId] = React.useState<string | null>(null)
  const [claimOpen, setClaimOpen] = React.useState(false)
  const [claimEmail, setClaimEmail] = React.useState('')
  const [claimSending, setClaimSending] = React.useState(false)
  const [claimMsg, setClaimMsg] = React.useState<{ ok: boolean; text: string; devLink?: string } | null>(null)

  React.useEffect(() => {
    if (!builderId) return
    Promise.all([
      fetch(`/api/builders/${builderId}`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      fetch(`/api/builders/${builderId}/notes`, { credentials: 'include' }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/auth/get-session', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([b, n, session]) => {
      setBuilder(b)
      setNotes(Array.isArray(n) ? n : [])
      setMeId(session?.user?.id ?? null)
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

  const handleClaim = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!claimEmail.trim()) return
    setClaimSending(true)
    setClaimMsg(null)
    try {
      const res = await fetch(`/api/builders/${builderId}/claim`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: claimEmail.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        setClaimMsg({ ok: true, text: data.message ?? 'Check your email for the verification link.', devLink: data.devLink })
      } else {
        setClaimMsg({ ok: false, text: data.error ?? 'Failed to start claim' })
      }
    } catch {
      setClaimMsg({ ok: false, text: 'Network error' })
    } finally {
      setClaimSending(false)
    }
  }

  const isMyProfile = builder?.claimedByUserId && meId && builder.claimedByUserId === meId

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-bh-text-muted">Loading...</p>
      </div>
    )
  }

  if (!builder) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <Link
          to="/explore"
          className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded"
        >
          <ArrowLeft className="w-4 h-4" /> Back to explore
        </Link>
        <div className="card text-center py-12" data-testid="builder-not-found">
          <p className="text-bh-text-muted mb-2">This builder isn't in the public directory yet.</p>
          <p className="text-xs text-bh-text-dim">
            Try the <Link to="/explore" className="text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded px-0.5">explorer</Link> to
            find active builders, or check back soon — claimed profiles are added regularly.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link
        to="/search"
        className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-6 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded"
      >
        <ArrowLeft className="w-4 h-4" /> Back to search
      </Link>

      <div className="card rounded-3xl bg-bh-surface border-bh-border shadow-sm mb-6">
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
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <h1 className="text-2xl font-bold text-bh-text">
                {builder.displayName ?? builder.username}
              </h1>
              {builder.isVerified && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-bh-success/10 text-bh-success border border-bh-success/30"
                  title="This profile is verified and maintained by the builder."
                >
                  <BadgeCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  Verified
                </span>
              )}
              <SourceBadge source={builder.source} />
            </div>

            {builder.bio && (
              <p className="text-bh-text-muted mb-3">{builder.bio}</p>
            )}

            <div className="flex items-center gap-4 text-sm text-bh-text-muted mb-4 flex-wrap">
              {builder.country && <span>{builder.country}</span>}
              {builder.language && <span>{builder.language}</span>}
              {builder.followersCount != null && (
                <span>{(builder.followersCount ?? 0).toLocaleString()} followers</span>
              )}
              {builder.isClaimed && builder.claimedAt && (
                <span className="inline-flex items-center gap-1 text-xs">
                  <Users className="w-3 h-3" />
                  Claimed {new Date(builder.claimedAt).toLocaleDateString()}
                </span>
              )}
            </div>

            {/* Open to status (claimed builders only) */}
            {builder.isClaimed && builder.openToStatus && builder.openToStatus.length > 0 && (
              <div className="mb-3 p-2.5 rounded-lg bg-bh-success/5 border border-bh-success/20">
                <p className="text-xs font-semibold text-bh-success inline-flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-bh-success inline-block" />
                  Open to: {builder.openToStatus.join(', ')}
                </p>
              </div>
            )}

            {/* Topics (claimed topics take precedence over scraped) */}
            {(() => {
              const topics = (builder.claimedTopics?.length ?? 0) > 0
                ? builder.claimedTopics
                : builder.topics
              if (!topics || topics.length === 0) return null
              return (
                <div className="flex flex-wrap gap-2 mb-4">
                  {topics.map(t => (
                    <span key={t} className="badge">{t}</span>
                  ))}
                </div>
              )
            })()}

            <a
              href={builder.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded px-0.5"
            >
              <Code className="w-4 h-4" />
              {builder.username} <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {/* Left Column: Hygiene & Code Style */}
        <div className="space-y-6">
          <HygieneCard
            builder={{
              followersCount: builder.followersCount,
              topics: builder.topics,
              language: builder.language,
              metadata: builder.metadata as Record<string, unknown> | undefined,
            }}
          />
          <CodeStyleCard
            builder={{
              language: builder.language,
              topics: builder.topics,
              followersCount: builder.followersCount,
              metadata: builder.metadata as Record<string, unknown> | undefined,
            }}
          />
        </div>

        {/* Right Column: Persona Card, Outreach Copilot, Action Bar & Notes */}
        <div className="space-y-6">
          <PersonaCard builderId={builder.id} canRefresh={Boolean(isMyProfile)} />

          <OutreachCopilot
            builder={{
              username: builder.username,
              displayName: builder.displayName,
              bio: builder.bio,
              topics: builder.topics,
              language: builder.language,
              followersCount: builder.followersCount,
              profileUrl: builder.profileUrl,
              source: builder.source,
            }}
          />

          {/* Action bar — varies based on auth + claim state */}
          <div className="card rounded-3xl bg-bh-surface border-bh-border shadow-sm p-6">
            {isMyProfile ? (
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/me"
                  className="btn-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2"
                >
                  <Sparkles className="w-4 h-4" /> Manage your profile
                </Link>
                <span className="text-xs text-bh-text-muted">
                  You claimed this profile on {builder.claimedAt ? new Date(builder.claimedAt).toLocaleDateString() : '—'}.
                </span>
              </div>
            ) : meId ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-bh-text-muted">
                <Lock className="w-4 h-4" />
                Save and notes are in the dashboard. Claim below if this is you.
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm text-bh-text-muted">
                <Lock className="w-4 h-4" />
                <Link
                  to="/auth/sign-in"
                  className="text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded px-0.5"
                >
                  Sign in
                </Link>
                {' '}to save this profile to a list.
              </div>
            )}

            {!builder.isClaimed && !isMyProfile && (
              <div className="mt-4 pt-4 border-t border-bh-border">
                {!claimOpen ? (
                  <button
                    onClick={() => setClaimOpen(true)}
                    className="btn-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2"
                    data-event="claim_cta_click"
                  >
                    <BadgeCheck className="w-4 h-4" /> Is this you? Claim this profile
                  </button>
                ) : (
                  <form onSubmit={handleClaim} className="space-y-3">
                    <p className="text-sm text-bh-text-muted">
                      Enter the email associated with this profile. We'll send a verification link.
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      <input
                        type="email"
                        value={claimEmail}
                        onChange={e => setClaimEmail(e.target.value)}
                        placeholder="you@example.com"
                        required
                        className="input-field flex-1 min-w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2"
                        autoFocus
                      />
                      <button
                        type="submit"
                        disabled={claimSending}
                        className="btn-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2"
                      >
                        {claimSending ? 'Sending…' : 'Send verification email'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setClaimOpen(false); setClaimMsg(null) }}
                        className="btn-ghost focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2"
                      >
                        Cancel
                      </button>
                    </div>
                    {claimMsg && (
                      <div
                        className={`text-sm p-3 rounded-lg border ${
                          claimMsg.ok
                            ? 'border-bh-success/30 bg-bh-success/10 text-bh-success'
                            : 'border-bh-danger/30 bg-bh-danger/10 text-bh-danger'
                        }`}
                        role={claimMsg.ok ? 'status' : 'alert'}
                      >
                        <p>{claimMsg.text}</p>
                        {claimMsg.devLink && (
                          <p className="mt-2 text-xs">
                            <strong>Dev mode:</strong>{' '}
                            <a
                              href={claimMsg.devLink}
                              className="underline break-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded px-0.5"
                            >
                              {claimMsg.devLink}
                            </a>
                          </p>
                        )}
                      </div>
                    )}
                  </form>
                )}
              </div>
            )}
          </div>

          {/* Notes Section Card */}
          <div className="card rounded-3xl bg-bh-surface border-bh-border shadow-sm p-6">
            <h3 className="text-base font-semibold text-bh-text mb-4 flex items-center gap-2">
              <FileText className="w-4 h-4" aria-hidden="true" />
              Notes
            </h3>

            {meId ? (
              <>
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
                    className="input-field flex-1 resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2"
                    rows={2}
                  />
                  <button
                    onClick={handleSaveNote}
                    disabled={savingNote || !noteText.trim()}
                    className="btn-primary flex items-center gap-2 h-fit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2"
                  >
                    <Save className="w-4 h-4" />
                    {savingNote ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-bh-text-muted">
                <Link
                  to="/auth/sign-in"
                  className="text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded px-0.5"
                >
                  Sign in
                </Link>
                {' '}to add private notes about this builder.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SourceBadge({ source }: { source: string }) {
  const cls = source === 'github' ? 'badge-github'
    : source === 'reddit' ? 'badge-reddit'
    : source === 'hn' ? 'badge-hn'
    : source === 'devto' ? 'badge-devto'
    : source === 'lobsters' ? 'badge-lobsters'
    : source === 'stackoverflow' ? 'badge-stackoverflow'
    : source === 'npm' ? 'badge-npm'
    : source === 'huggingface' ? 'badge-huggingface'
    : source === 'gitlab' ? 'badge-gitlab'
    : source === 'codeberg' ? 'badge-codeberg'
    : source === 'hashnode' ? 'badge-hashnode'
    : source === 'sourcehut' ? 'badge-sourcehut'
    : 'badge'
  const label = source === 'hn' ? 'Hacker News' : source
  return <span className={cls}>{label}</span>
}
