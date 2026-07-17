import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { BadgeCheck, ExternalLink, Sparkles, Edit3, X, Plus, Save } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'

interface ClaimedBuilder {
  id: string
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  source: string
  bio?: string | null
  topics?: string[]
  claimedTopics?: string[]
  openToStatus?: string[]
  isVerified?: boolean
  followersCount?: number
  lastSeen?: string | null
  claimedAt?: string | null
  profileUrl?: string
  metadata?: Record<string, unknown>
}

const OPEN_TO_OPTIONS = [
  { value: 'chats', label: 'Chats about my work' },
  { value: 'mentoring', label: 'Mentoring' },
  { value: 'collaboration', label: 'Open source collaboration' },
  { value: 'hires', label: 'Considering job offers' },
  { value: 'consulting', label: 'Consulting work' },
  { value: 'nothing', label: 'Not actively looking' },
]

export const Route = createFileRoute('/_dashboard/me/')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw new Error('Unauthorized')
    }
    return { user }
  },
  loader: async () => ({}),
  component: MePage,
})

function MePage() {
  const [builders, setBuilders] = React.useState<ClaimedBuilder[]>([])
  const [loading, setLoading] = React.useState(true)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [editTopics, setEditTopics] = React.useState<string[]>([])
  const [editOpenTo, setEditOpenTo] = React.useState<string[]>([])
  const [newTopic, setNewTopic] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [saveMsg, setSaveMsg] = React.useState<{ ok: boolean; text: string } | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/me/builder', { credentials: 'include' })
      if (!res.ok) {
        setBuilders([])
        return
      }
      const data = await res.json()
      setBuilders(Array.isArray(data) ? data : [data].filter(Boolean))
    } catch {
      setBuilders([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  const startEdit = (b: ClaimedBuilder) => {
    setEditing(b.id)
    setEditTopics(b.claimedTopics ?? b.topics ?? [])
    setEditOpenTo(b.openToStatus ?? [])
    setNewTopic('')
    setSaveMsg(null)
  }

  const cancelEdit = () => {
    setEditing(null)
    setSaveMsg(null)
  }

  const addTopic = () => {
    const t = newTopic.trim()
    if (t && !editTopics.includes(t)) {
      setEditTopics([...editTopics, t])
      setNewTopic('')
    }
  }

  const removeTopic = (t: string) => setEditTopics(editTopics.filter(x => x !== t))

  const toggleOpenTo = (v: string) => {
    setEditOpenTo(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v])
  }

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const res = await fetch(`/api/me/builder/${editing}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimedTopics: editTopics, openToStatus: editOpenTo }),
      })
      if (res.ok) {
        setSaveMsg({ ok: true, text: 'Saved!' })
        await load()
        setTimeout(() => setEditing(null), 800)
      } else {
        const data = await res.json().catch(() => ({}))
        setSaveMsg({ ok: false, text: data.error ?? 'Save failed' })
      }
    } catch {
      setSaveMsg({ ok: false, text: 'Network error' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-bh-surface rounded" />
          <div className="h-32 bg-bh-surface rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto">
      <header className="mb-8">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-1 flex items-center gap-3">
          Your profile
          <Sparkles className="w-6 h-6 text-bh-accent" aria-hidden="true" />
        </h1>
        <p className="text-bh-text-muted">
          Manage the profiles you've claimed and how others see you.
        </p>
      </header>

      {builders.length === 0 ? (
        <div className="card text-center py-12">
          <BadgeCheck className="w-10 h-10 text-bh-text-muted mx-auto mb-3" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-bh-text mb-2">No claimed profiles yet</h2>
          <p className="text-sm text-bh-text-muted max-w-md mx-auto mb-4">
            Search for yourself, find your profile, and click <strong>Is this you? Claim this profile</strong> on the profile page.
            We'll send you a verification email and you'll be able to enrich your profile.
          </p>
          <Link to="/search" className="btn-primary inline-flex">
            Find your profile
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {builders.map(b => {
            const isEditing = editing === b.id
            return (
              <div key={b.id} className="card">
                <div className="flex items-start gap-4 mb-4">
                  {b.avatarUrl || b.metadata?.avatarUrl ? (
                    <img
                      src={(b.avatarUrl ?? b.metadata?.avatarUrl) as string}
                      alt={b.username}
                      className="w-14 h-14 rounded-full border border-bh-border shrink-0"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-bh-accent/20 flex items-center justify-center text-bh-accent text-xl font-semibold shrink-0">
                      {(b.displayName ?? b.username)[0]?.toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h2 className="text-lg font-semibold text-bh-text truncate">
                        {b.displayName ?? b.username}
                      </h2>
                      {b.isVerified && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-semibold bg-bh-success/10 text-bh-success border border-bh-success/30">
                          <BadgeCheck className="w-3 h-3" aria-hidden="true" /> Verified
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-bh-text-dim">@{b.username} · {b.source}</p>
                    {b.bio && <p className="text-sm text-bh-text-muted mt-1.5 line-clamp-2">{b.bio}</p>}
                  </div>
                  <Link
                    to="/builders/$builderId"
                    params={{ builderId: b.id }}
                    className="btn-ghost btn-sm"
                    title="View public profile"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </Link>
                </div>

                {isEditing ? (
                  <div className="space-y-4 border-t border-bh-border pt-4">
                    <div>
                      <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-2">
                        Your topics
                      </label>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {editTopics.map(t => (
                          <span key={t} className="badge inline-flex items-center gap-1.5">
                            {t}
                            <button
                              type="button"
                              onClick={() => removeTopic(t)}
                              className="hover:text-bh-danger"
                              aria-label={`Remove ${t}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {editTopics.length === 0 && (
                          <span className="text-xs text-bh-text-dim italic">No topics yet</span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newTopic}
                          onChange={e => setNewTopic(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTopic() } }}
                          placeholder="Add a topic..."
                          className="input-field flex-1"
                        />
                        <button
                          type="button"
                          onClick={addTopic}
                          disabled={!newTopic.trim()}
                          className="btn-secondary"
                        >
                          <Plus className="w-4 h-4" /> Add
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-2">
                        Open to
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {OPEN_TO_OPTIONS.map(opt => {
                          const active = editOpenTo.includes(opt.value)
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => toggleOpenTo(opt.value)}
                              className={`text-left px-3 py-2 rounded-lg border text-sm transition-all ${
                                active
                                  ? 'border-bh-accent bg-bh-accent-soft text-bh-text'
                                  : 'border-bh-border text-bh-text-muted hover:border-bh-border-strong hover:text-bh-text'
                              }`}
                            >
                              <span className="inline-flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${active ? 'bg-bh-accent' : 'bg-bh-text-dim'}`} />
                                {opt.label}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {saveMsg && (
                      <p
                        role={saveMsg.ok ? 'status' : 'alert'}
                        className={`text-sm ${saveMsg.ok ? 'text-bh-success' : 'text-bh-danger'}`}
                      >
                        {saveMsg.text}
                      </p>
                    )}

                    <div className="flex gap-2">
                      <button onClick={save} disabled={saving} className="btn-primary">
                        <Save className="w-4 h-4" />
                        {saving ? 'Saving…' : 'Save changes'}
                      </button>
                      <button onClick={cancelEdit} className="btn-ghost">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 border-t border-bh-border pt-4">
                    {((b.claimedTopics?.length ?? 0) > 0 || (b.topics?.length ?? 0) > 0) && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-1.5">Topics</p>
                        <div className="flex flex-wrap gap-1.5">
                          {(b.claimedTopics?.length ?? 0) > 0 ? b.claimedTopics!.map(t => (
                            <span key={t} className="badge">{t}</span>
                          )) : b.topics!.map(t => (
                            <span key={t} className="badge opacity-70">{t} <span className="text-bh-text-dim text-[10px]">(scraped)</span></span>
                          ))}
                        </div>
                      </div>
                    )}

                    {b.openToStatus && b.openToStatus.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim mb-1.5">Open to</p>
                        <p className="text-sm text-bh-text inline-flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-bh-success inline-block" />
                          {b.openToStatus.map(v => OPEN_TO_OPTIONS.find(o => o.value === v)?.label ?? v).join(', ')}
                        </p>
                      </div>
                    )}

                    <button onClick={() => startEdit(b)} className="btn-secondary btn-sm">
                      <Edit3 className="w-3.5 h-3.5" /> Edit profile
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
