import * as React from 'react'
import { Check, Copy, Eye, ExternalLink } from 'lucide-react'
import { Button, Textarea } from '~/components/ui'
import {
  HEADLINE_MAX,
  INTRODUCTION_MAX,
  MAX_SELECTED_PROJECTS,
  PORTFOLIO_THEMES,
  type PortfolioProject,
  type PortfolioSettings as PortfolioSettingsData,
} from '~/shared/lib/portfolio'

interface DraftResponse {
  claimId: string
  settings: PortfolioSettingsData
  projectCandidates: PortfolioProject[]
}

const SITE_URL = 'https://builderhunt.dev'

interface PortfolioSettingsProps {
  claimId: string
}

export function PortfolioSettings({ claimId }: PortfolioSettingsProps) {
  const [draft, setDraft] = React.useState<DraftResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = React.useState(false)

  const load = React.useCallback(() => {
    setLoading(true)
    fetch(`/api/me/builder-claims/${claimId}/portfolio`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => setDraft(data))
      .finally(() => setLoading(false))
  }, [claimId])

  React.useEffect(() => { load() }, [load])

  const patch = async (body: Partial<PortfolioSettingsData>) => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/me/builder-claims/${claimId}/portfolio`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg({ ok: false, text: data.error ?? 'Failed to save' })
        return
      }
      setDraft((prev) => prev ? { ...prev, settings: data.settings } : prev)
      setMsg({ ok: true, text: 'Saved as draft.' })
    } catch {
      setMsg({ ok: false, text: 'Network error' })
    } finally {
      setSaving(false)
    }
  }

  const transition = async (action: 'publish' | 'unpublish') => {
    setSaving(true)
    setMsg(null)
    try {
      // Publish must reflect what's on screen, not just whatever was last
      // saved — otherwise "type a headline, hit Publish" silently publishes
      // a blank page. Save has no such requirement (a plain PATCH never
      // implies publish), so this save-then-publish is one-directional.
      if (action === 'publish' && draft) {
        const saveRes = await fetch(`/api/me/builder-claims/${claimId}/portfolio`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft.settings),
        })
        if (!saveRes.ok) {
          const saveData = await saveRes.json().catch(() => ({}))
          setMsg({ ok: false, text: saveData.error ?? 'Failed to save before publishing' })
          return
        }
      }
      const res = await fetch(`/api/me/builder-claims/${claimId}/portfolio/${action}`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg({ ok: false, text: data.error ?? `Failed to ${action}` })
        return
      }
      setDraft((prev) => prev ? { ...prev, settings: data.settings } : prev)
      setMsg({ ok: true, text: action === 'publish' ? 'Published! Your portfolio is now public.' : 'Unpublished — no longer public.' })
    } catch {
      setMsg({ ok: false, text: 'Network error' })
    } finally {
      setSaving(false)
    }
  }

  const toggleProject = (projectId: string) => {
    if (!draft) return
    const current = draft.settings.selectedProjectIds
    const next = current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : current.length >= MAX_SELECTED_PROJECTS ? current : [...current, projectId]
    setDraft({ ...draft, settings: { ...draft.settings, selectedProjectIds: next } })
  }

  const copyLink = () => {
    navigator.clipboard.writeText(`${SITE_URL}/portfolio/${claimId}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (loading) return <p className="text-sm text-bh-text-dim">Loading portfolio settings…</p>
  if (!draft) return null

  const { settings } = draft

  return (
    <div className="card p-5 space-y-4" data-testid="portfolio-settings">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold text-bh-text">Public portfolio</h3>
        {settings.published ? (
          <span className="badge badge-success inline-flex items-center gap-1">
            <Eye className="w-3 h-3" aria-hidden="true" /> Live
          </span>
        ) : (
          <span className="text-xs text-bh-text-dim">Draft — not public</span>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-bh-text-muted" htmlFor="portfolio-theme">Theme</label>
        <select
          id="portfolio-theme"
          className="input-field"
          value={settings.theme}
          onChange={(e) => setDraft({ ...draft, settings: { ...settings, theme: e.target.value as typeof settings.theme } })}
        >
          {PORTFOLIO_THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-bh-text-muted" htmlFor="portfolio-headline">
          Headline ({settings.headline.length}/{HEADLINE_MAX})
        </label>
        <input
          id="portfolio-headline"
          className="input-field"
          maxLength={HEADLINE_MAX}
          value={settings.headline}
          onChange={(e) => setDraft({ ...draft, settings: { ...settings, headline: e.target.value } })}
          placeholder="e.g. Ships Rust CLIs for indie founders"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-bh-text-muted" htmlFor="portfolio-intro">
          Introduction ({settings.introduction.length}/{INTRODUCTION_MAX})
        </label>
        <Textarea
          id="portfolio-intro"
          maxLength={INTRODUCTION_MAX}
          value={settings.introduction}
          onChange={(e) => setDraft({ ...draft, settings: { ...settings, introduction: e.target.value } })}
          rows={4}
        />
      </div>

      {draft.projectCandidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-bh-text-muted">
            Featured projects ({settings.selectedProjectIds.length}/{MAX_SELECTED_PROJECTS})
          </p>
          <ul className="space-y-1.5" role="list">
            {draft.projectCandidates.map((project) => (
              <li key={project.id}>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.selectedProjectIds.includes(project.id)}
                    onChange={() => toggleProject(project.id)}
                    disabled={!settings.selectedProjectIds.includes(project.id) && settings.selectedProjectIds.length >= MAX_SELECTED_PROJECTS}
                  />
                  <span className="text-bh-text">{project.name}</span>
                  <span className="text-bh-text-dim text-xs">★ {project.stars}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-bh-border">
        <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => patch(settings)}>
          Save draft
        </Button>
        {settings.published ? (
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => transition('unpublish')}>
            Unpublish
          </Button>
        ) : (
          <Button type="button" variant="primary" size="sm" disabled={saving} onClick={() => transition('publish')}>
            Publish
          </Button>
        )}
        {settings.published && (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={copyLink} className="inline-flex items-center gap-1.5">
              {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <a
              href={`${SITE_URL}/portfolio/${claimId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost btn-sm inline-flex items-center gap-1.5"
            >
              View <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </>
        )}
      </div>

      {msg && (
        <p className={`text-xs ${msg.ok ? 'text-bh-success' : 'text-bh-danger'}`} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </div>
  )
}
