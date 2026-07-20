import * as React from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Compass, Loader2, Sparkles, ArrowRight, ArrowLeft } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { ai } from '~/shared/lib/ai/client'
import { AIDownloadPrompt } from '~/shared/components/AIDownloadPrompt'
import {
  manualCriteriaToVariant,
  type ExtractedCriteria,
  type QueryVariant,
} from '~/shared/lib/sprints-shared'

export const Route = createFileRoute('/_dashboard/sprints/new')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    return { user }
  },
  component: NewSprintWizard,
})

const EMPTY_CRITERIA: ExtractedCriteria = { skills: [], roles: [], seniority: 'unknown', locations: [], mustHaves: [] }

function toList(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

interface PreviewItem {
  variant: string
  source: string
  sourceId: string
  score: number
  profile: { username: string; displayName?: string; bio?: string; profileUrl: string; topics: string[] }
}

function NewSprintWizard() {
  const navigate = useNavigate()
  const [step, setStep] = React.useState<1 | 2 | 3>(1)

  // Step 1
  const [jdText, setJdText] = React.useState('')
  const [parsing, setParsing] = React.useState(false)
  const [parseNote, setParseNote] = React.useState<string | null>(null)
  const [criteria, setCriteria] = React.useState<ExtractedCriteria>(EMPTY_CRITERIA)

  // Step 2
  const [decomposing, setDecomposing] = React.useState(false)
  const [variants, setVariants] = React.useState<QueryVariant[]>([])

  // Step 3
  const [previewing, setPreviewing] = React.useState(false)
  const [previewItems, setPreviewItems] = React.useState<PreviewItem[] | null>(null)
  const [sprintName, setSprintName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const parseJd = async () => {
    if (jdText.trim().length < 80) {
      setError('Paste at least 80 characters of job description or CV text.')
      return
    }
    setError(null)
    setParsing(true)
    setParseNote(null)
    try {
      const result = await ai<ExtractedCriteria>('jd-parse', { text: jdText })
      setCriteria(result.output)
      setParseNote(result.via === 'server' ? 'Parsed via server AI.' : 'Parsed on-device.')
    } catch {
      setParseNote('AI parsing unavailable — fill in the criteria manually below.')
    } finally {
      setParsing(false)
      setStep(2)
    }
  }

  const decompose = async () => {
    setDecomposing(true)
    try {
      const result = await ai<{ variants: QueryVariant[] }>('criteria-decompose', criteria)
      setVariants(result.output.variants)
    } catch {
      setVariants([manualCriteriaToVariant(criteria)])
    } finally {
      setDecomposing(false)
      setStep(3)
    }
  }

  const runPreview = async () => {
    setPreviewing(true)
    setError(null)
    try {
      const res = await fetch('/api/sprints/preview', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Preview failed')
        return
      }
      setPreviewItems(data.items)
    } finally {
      setPreviewing(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/sprints', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: sprintName.trim() || 'Untitled sprint', criteria, variants }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to save sprint')
        return
      }
      navigate({ to: '/sprints/$sprintId', params: { sprintId: data.id } })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8" data-testid="sprint-wizard">
      <div className="flex items-center gap-2 mb-6">
        <Compass className="w-5 h-5 text-bh-accent" />
        <h1 className="text-xl font-bold text-bh-text">New sourcing sprint</h1>
      </div>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      {step === 1 && (
        <div className="card p-5 space-y-3">
          <h2 className="font-semibold text-bh-text">1. Paste a job description or CV</h2>
          <p className="text-xs text-bh-text-dim">
            On Chrome with built-in AI, this text is parsed on-device and never leaves your browser.
          </p>
          <AIDownloadPrompt />
          <textarea
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
            rows={10}
            className="w-full rounded-md border border-bh-border bg-bh-surface/40 p-3 text-sm text-bh-text"
            placeholder="Paste the job description or a candidate's CV here…"
            data-testid="sprint-jd-input"
          />
          <button
            type="button"
            onClick={parseJd}
            disabled={parsing}
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
            data-testid="sprint-parse-button"
          >
            {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Extract criteria
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="card p-5 space-y-3" data-testid="sprint-criteria-step">
          <h2 className="font-semibold text-bh-text">2. Review criteria</h2>
          {parseNote && <p className="text-xs text-bh-text-dim">{parseNote}</p>}
          <CriteriaFields criteria={criteria} onChange={setCriteria} />
          <div className="flex justify-between pt-2">
            <button type="button" onClick={() => setStep(1)} className="text-sm text-bh-text-dim inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="button"
              onClick={decompose}
              disabled={decomposing || criteria.skills.length === 0}
              className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
              data-testid="sprint-decompose-button"
            >
              {decomposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              Propose search variants
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card p-5 space-y-4" data-testid="sprint-variants-step">
          <h2 className="font-semibold text-bh-text">3. Review variants, preview, and save</h2>
          <ul className="space-y-2">
            {variants.map((variant, i) => (
              <li key={i} className="rounded-md border border-bh-border p-3 text-sm">
                <p className="font-medium text-bh-text">{variant.name}</p>
                <p className="text-xs text-bh-text-dim">{variant.keywords.join(', ')}</p>
                <p className="text-xs text-bh-text-dim italic">{variant.rationale}</p>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={runPreview}
            disabled={previewing}
            className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
            data-testid="sprint-preview-button"
          >
            {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Preview results
          </button>

          {previewItems && (
            <p className="text-sm text-bh-text-dim" data-testid="sprint-preview-count">
              {previewItems.length} matching people found (not saved yet).
            </p>
          )}

          <div className="pt-2 border-t border-bh-border space-y-2">
            <input
              value={sprintName}
              onChange={(e) => setSprintName(e.target.value)}
              placeholder="Sprint name"
              className="w-full rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
              data-testid="sprint-name-input"
            />
            <div className="flex justify-between">
              <button type="button" onClick={() => setStep(2)} className="text-sm text-bh-text-dim inline-flex items-center gap-1">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
                data-testid="sprint-save-button"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Save sprint
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CriteriaFields({ criteria, onChange }: { criteria: ExtractedCriteria; onChange: (c: ExtractedCriteria) => void }) {
  return (
    <div className="space-y-2">
      <label className="block text-xs text-bh-text-dim">
        Skills (comma separated)
        <input
          value={criteria.skills.join(', ')}
          onChange={(e) => onChange({ ...criteria, skills: toList(e.target.value) })}
          className="mt-1 w-full rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
          data-testid="sprint-skills-input"
        />
      </label>
      <label className="block text-xs text-bh-text-dim">
        Roles (comma separated)
        <input
          value={criteria.roles.join(', ')}
          onChange={(e) => onChange({ ...criteria, roles: toList(e.target.value) })}
          className="mt-1 w-full rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
        />
      </label>
      <label className="block text-xs text-bh-text-dim">
        Seniority
        <select
          value={criteria.seniority}
          onChange={(e) => onChange({ ...criteria, seniority: e.target.value as ExtractedCriteria['seniority'] })}
          className="mt-1 w-full rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
        >
          <option value="unknown">Unknown</option>
          <option value="junior">Junior</option>
          <option value="mid">Mid</option>
          <option value="senior">Senior</option>
        </select>
      </label>
      <label className="block text-xs text-bh-text-dim">
        Locations (comma separated)
        <input
          value={criteria.locations.join(', ')}
          onChange={(e) => onChange({ ...criteria, locations: toList(e.target.value) })}
          className="mt-1 w-full rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm text-bh-text"
        />
      </label>
    </div>
  )
}
