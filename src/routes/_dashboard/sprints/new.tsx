import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Compass, Loader2, Sparkles, ArrowRight, ArrowLeft, Upload, X, Check, AlertTriangle } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { ai } from '~/shared/lib/ai/client'
import { AIDownloadPrompt } from '~/shared/components/AIDownloadPrompt'
import { PersonResultCard, type PersonCardData } from '~/modules/search/components/PersonResultCard'
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
const MAX_FILES = 10
const ALLOWED_EXTENSIONS = ['.txt', '.md']

function toList(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

function randomEntryId(): string {
  return Math.random().toString(36).slice(2)
}

// Step 1/2 — one queue entry per uploaded/pasted document. Batch upload is
// capped at MAX_FILES and restricted to .txt/.md — PDF/DOCX parsing needs a
// dedicated extraction library and is an explicitly deferred future phase
// (see plans/ai-sourcing-sprints/spec.md's v2 note).
interface FileEntry {
  id: string
  name: string
  text: string
  status: 'pending' | 'parsing' | 'ready' | 'error'
  note: string | null
  criteria: ExtractedCriteria
  selected: boolean
}

// Step 3 — each selected file becomes its own sprint draft (its own
// criteria + variants + save action), since one saved sprint = one
// criteria set. Batch upload produces up to MAX_FILES independent drafts.
interface PreviewItem {
  variant: string
  source: string
  sourceId: string
  score: number
  profile: { username: string; displayName?: string; bio?: string; profileUrl: string; topics: string[] }
}

interface SprintDraft {
  fileId: string
  fileName: string
  criteria: ExtractedCriteria
  variants: QueryVariant[]
  variantSelected: boolean[]
  previewing: boolean
  previewCounts: Record<string, number> | null
  previewItems: PreviewItem[] | null
  name: string
  saving: boolean
  savedSprintId: string | null
  error: string | null
}

function NewSprintWizard() {
  const [step, setStep] = React.useState<1 | 2 | 3>(1)
  const [files, setFiles] = React.useState<FileEntry[]>([])
  const [jdText, setJdText] = React.useState('')
  const [parsingAll, setParsingAll] = React.useState(false)
  const [drafts, setDrafts] = React.useState<SprintDraft[]>([])
  const [decomposingAll, setDecomposingAll] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const addFiles = async (fileList: FileList) => {
    setError(null)
    const incoming = Array.from(fileList)
    const rejected = incoming.filter((f) => !ALLOWED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)))
    if (rejected.length > 0) {
      setError(`Only .txt and .md files are supported for now (rejected: ${rejected.map((f) => f.name).join(', ')}). PDF/DOCX support is planned for a future update.`)
    }
    const accepted = incoming.filter((f) => ALLOWED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)))
    if (files.length + accepted.length > MAX_FILES) {
      setError(`You can upload at most ${MAX_FILES} files at once.`)
      return
    }
    const entries = await Promise.all(accepted.map(async (file) => ({
      id: randomEntryId(),
      name: file.name,
      text: await file.text(),
      status: 'pending' as const,
      note: null,
      criteria: EMPTY_CRITERIA,
      selected: true,
    })))
    setFiles((prev) => [...prev, ...entries])
  }

  const addPastedText = () => {
    if (jdText.trim().length < 80) {
      setError('Paste at least 80 characters of job description or CV text.')
      return
    }
    if (files.length >= MAX_FILES) {
      setError(`You can upload at most ${MAX_FILES} files at once.`)
      return
    }
    setError(null)
    setFiles((prev) => [...prev, {
      id: randomEntryId(),
      name: `Pasted text ${prev.length + 1}`,
      text: jdText,
      status: 'pending',
      note: null,
      criteria: EMPTY_CRITERIA,
      selected: true,
    }])
    setJdText('')
  }

  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id))

  const parseAll = async () => {
    if (files.length === 0) {
      setError('Add at least one file or pasted document first.')
      return
    }
    setError(null)
    setParsingAll(true)
    for (const entry of files) {
      if (entry.status !== 'pending') continue
      setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: 'parsing' } : f)))
      try {
        const result = await ai<ExtractedCriteria>('jd-parse', { text: entry.text })
        setFiles((prev) => prev.map((f) => (f.id === entry.id
          ? { ...f, status: 'ready', criteria: result.output, note: result.via === 'server' ? 'Parsed via server AI.' : 'Parsed on-device.' }
          : f)))
      } catch (err) {
        const message = err instanceof Error && (err as { reason?: string }).reason === 'budget'
          ? 'Daily AI limit reached — fill in criteria manually below.'
          : 'AI parsing unavailable — fill in criteria manually below.'
        setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, status: 'ready', note: message } : f)))
      }
    }
    setParsingAll(false)
    setStep(2)
  }

  const updateFileCriteria = (id: string, criteria: ExtractedCriteria) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, criteria } : f)))
  }

  const toggleFileSelected = (id: string) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f)))
  }

  const selectedFiles = files.filter((f) => f.status === 'ready' && f.selected && f.criteria.skills.length > 0)

  const decomposeAll = async () => {
    if (selectedFiles.length === 0) {
      setError('Select at least one document with at least one skill.')
      return
    }
    setError(null)
    setDecomposingAll(true)
    const nextDrafts: SprintDraft[] = []
    for (const entry of selectedFiles) {
      let variants: QueryVariant[]
      try {
        const result = await ai<{ variants: QueryVariant[] }>('criteria-decompose', entry.criteria)
        variants = result.output.variants
      } catch {
        variants = [manualCriteriaToVariant(entry.criteria)]
      }
      nextDrafts.push({
        fileId: entry.id,
        fileName: entry.name,
        criteria: entry.criteria,
        variants,
        variantSelected: variants.map(() => true),
        previewing: false,
        previewCounts: null,
        previewItems: null,
        name: entry.name.replace(/\.(txt|md)$/i, ''),
        saving: false,
        savedSprintId: null,
        error: null,
      })
    }
    setDrafts(nextDrafts)
    setDecomposingAll(false)
    setStep(3)
  }

  const toggleDraftVariant = (fileId: string, index: number) => {
    setDrafts((prev) => prev.map((d) => (d.fileId === fileId
      ? { ...d, variantSelected: d.variantSelected.map((v, i) => (i === index ? !v : v)), previewCounts: null, previewItems: null }
      : d)))
  }

  const setDraftName = (fileId: string, name: string) => {
    setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, name } : d)))
  }

  const previewDraft = async (fileId: string) => {
    setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, previewing: true, error: null } : d)))
    const draft = drafts.find((d) => d.fileId === fileId)
    if (!draft) return
    const variants = draft.variants.filter((_, i) => draft.variantSelected[i])
    try {
      const res = await fetch('/api/sprints/preview', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants }),
      })
      const data = await res.json()
      if (!res.ok) {
        setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, error: data.error ?? 'Preview failed' } : d)))
        return
      }
      const counts: Record<string, number> = {}
      for (const item of data.items as PreviewItem[]) {
        counts[item.variant] = (counts[item.variant] ?? 0) + 1
      }
      setDrafts((prev) => prev.map((d) => (d.fileId === fileId
        ? { ...d, previewCounts: counts, previewItems: data.items }
        : d)))
    } finally {
      setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, previewing: false } : d)))
    }
  }

  const saveDraft = async (fileId: string) => {
    setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, saving: true, error: null } : d)))
    const draft = drafts.find((d) => d.fileId === fileId)
    if (!draft) return
    const variants = draft.variants.filter((_, i) => draft.variantSelected[i])
    try {
      const res = await fetch('/api/sprints', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft.name.trim() || draft.fileName, criteria: draft.criteria, variants }),
      })
      const data = await res.json()
      if (!res.ok) {
        setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, error: data.error ?? 'Failed to save sprint' } : d)))
        return
      }
      setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, savedSprintId: data.id } : d)))
    } finally {
      setDrafts((prev) => prev.map((d) => (d.fileId === fileId ? { ...d, saving: false } : d)))
    }
  }

  const allSaved = drafts.length > 0 && drafts.every((d) => d.savedSprintId)

  return (
    <div className="max-w-2xl mx-auto px-4 py-8" data-testid="sprint-wizard">
      <div className="flex items-center gap-2 mb-6">
        <Compass className="w-5 h-5 text-bh-accent" />
        <h1 className="text-xl font-bold text-bh-text">New sourcing sprint</h1>
      </div>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      {step === 1 && (
        <div className="card p-5 space-y-3">
          <h2 className="font-semibold text-bh-text">1. Add job descriptions or CVs</h2>
          <p className="text-xs text-bh-text-dim">
            Upload up to {MAX_FILES} <code>.txt</code>/<code>.md</code> files, or paste text below — each
            document becomes its own sourcing sprint. On Chrome with built-in AI, parsing happens on-device
            and never leaves your browser. PDF/DOCX support is planned for later.
          </p>
          <AIDownloadPrompt />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full rounded-md border-2 border-dashed border-bh-border p-6 text-sm text-bh-text-dim hover:border-bh-accent/50 flex flex-col items-center gap-1.5"
            data-testid="sprint-file-drop"
          >
            <Upload className="w-5 h-5" />
            Click to choose .txt/.md files ({files.length}/{MAX_FILES})
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />

          <div className="flex items-center gap-2">
            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={4}
              className="flex-1 rounded-md border border-bh-border bg-bh-surface/40 p-3 text-sm text-bh-text"
              placeholder="…or paste text here"
              data-testid="sprint-jd-input"
            />
            <button type="button" onClick={addPastedText} className="btn-secondary px-3 py-2 text-sm shrink-0">
              Add
            </button>
          </div>

          {files.length > 0 && (
            <ul className="space-y-1.5" data-testid="sprint-file-queue">
              {files.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 rounded-md border border-bh-border p-2 text-sm">
                  <span className="truncate text-bh-text">{f.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-bh-text-dim">{f.status}</span>
                    <button type="button" onClick={() => removeFile(f.id)} aria-label={`Remove ${f.name}`}>
                      <X className="w-3.5 h-3.5 text-bh-text-dim" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={parseAll}
            disabled={parsingAll || files.length === 0}
            className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
            data-testid="sprint-parse-button"
          >
            {parsingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Extract criteria ({files.length})
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4" data-testid="sprint-criteria-step">
          {files.map((f) => (
            <div key={f.id} className="card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-bh-text truncate">{f.name}</h2>
                <label className="inline-flex items-center gap-1.5 text-xs text-bh-text-dim shrink-0">
                  <input type="checkbox" checked={f.selected} onChange={() => toggleFileSelected(f.id)} />
                  Include
                </label>
              </div>
              {f.note && <p className="text-xs text-bh-text-dim">{f.note}</p>}
              <CriteriaFields criteria={f.criteria} onChange={(c) => updateFileCriteria(f.id, c)} />
            </div>
          ))}
          <div className="flex justify-between pt-2">
            <button type="button" onClick={() => setStep(1)} className="text-sm text-bh-text-dim inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="button"
              onClick={decomposeAll}
              disabled={decomposingAll || selectedFiles.length === 0}
              className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
              data-testid="sprint-decompose-button"
            >
              {decomposingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              Propose search variants ({selectedFiles.length})
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4" data-testid="sprint-variants-step">
          {drafts.map((draft) => (
            <div key={draft.fileId} className="card p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <input
                  value={draft.name}
                  onChange={(e) => setDraftName(draft.fileId, e.target.value)}
                  disabled={Boolean(draft.savedSprintId)}
                  className="flex-1 rounded-md border border-bh-border bg-bh-surface/40 p-2 text-sm font-medium text-bh-text"
                  data-testid="sprint-name-input"
                />
                {draft.savedSprintId && (
                  <Link
                    to="/sprints/$sprintId"
                    params={{ sprintId: draft.savedSprintId }}
                    className="text-xs text-bh-accent inline-flex items-center gap-1 shrink-0"
                  >
                    <Check className="w-3.5 h-3.5" /> Saved
                  </Link>
                )}
              </div>

              <ul className="space-y-2">
                {draft.variants.map((variant, i) => (
                  <li key={i} className="rounded-md border border-bh-border p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={draft.variantSelected[i]}
                        disabled={Boolean(draft.savedSprintId)}
                        onChange={() => toggleDraftVariant(draft.fileId, i)}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-bh-text">{variant.name}</p>
                          {draft.previewCounts && (
                            <span className="text-xs text-bh-text-dim">
                              ~{draft.previewCounts[variant.name] ?? 0} candidates
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-bh-text-dim">{variant.keywords.join(', ')}</p>
                        <p className="text-xs text-bh-text-dim italic">{variant.rationale}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {draft.error && (
                <p className="text-sm text-red-500 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {draft.error}
                </p>
              )}

              {!draft.savedSprintId && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => previewDraft(draft.fileId)}
                    disabled={draft.previewing || draft.variantSelected.every((v) => !v)}
                    className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
                    data-testid="sprint-preview-button"
                  >
                    {draft.previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Preview results
                  </button>
                  {draft.previewItems != null && (
                    <span className="text-xs text-bh-text-dim" data-testid="sprint-preview-count">
                      {draft.previewItems.length} matching people found (not saved yet)
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => saveDraft(draft.fileId)}
                    disabled={draft.saving || draft.variantSelected.every((v) => !v)}
                    className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm ml-auto"
                    data-testid="sprint-save-button"
                  >
                    {draft.saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Save sprint
                  </button>
                </div>
              )}

              {draft.previewItems != null && (
                draft.previewItems.length === 0 ? (
                  <p className="text-sm text-bh-text-dim">No matches yet for the selected variants — try enabling more variants above.</p>
                ) : (
                  <ul className="space-y-2 max-h-96 overflow-y-auto pr-1" data-testid="sprint-preview-list">
                    {draft.previewItems.map((item) => {
                      const cardData: PersonCardData = {
                        id: `${item.source}:${item.sourceId}`,
                        username: item.profile.username,
                        displayName: item.profile.displayName,
                        source: item.source,
                        bio: item.profile.bio,
                        profileUrl: item.profile.profileUrl,
                        topics: item.profile.topics,
                        score: item.score,
                      }
                      return (
                        <li key={cardData.id}>
                          <PersonResultCard builder={cardData} />
                        </li>
                      )
                    })}
                  </ul>
                )
              )}
            </div>
          ))}

          <div className="flex justify-between pt-2">
            <button type="button" onClick={() => setStep(2)} className="text-sm text-bh-text-dim inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            {allSaved && (
              <Link to="/sprints" className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
                Go to sprints
              </Link>
            )}
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
