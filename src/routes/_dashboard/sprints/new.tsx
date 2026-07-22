import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
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
import { motionTokens } from '~/shared/lib/motion/tokens'
import {
  Input, Textarea, Label, Switch, Checkbox, Button,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '~/components/ui'

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

const WIZARD_STEPS = [
  { n: 1, label: 'Add documents' },
  { n: 2, label: 'Review criteria' },
  { n: 3, label: 'Search variants' },
] as const

function SprintStepper({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center mb-8" aria-label="Sprint progress">
      {WIZARD_STEPS.map((s, i) => {
        const done = s.n < current
        const active = s.n === current
        return (
          <React.Fragment key={s.n}>
            {i > 0 && (
              <div className={`h-px flex-1 mx-2 transition-colors ${done ? 'bg-bh-accent' : 'bg-bh-border'}`} aria-hidden="true" />
            )}
            <li className="flex items-center gap-2 shrink-0">
              <span
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors ${
                  done
                    ? 'bg-bh-accent border-transparent text-[var(--color-bh-accent-contrast)]'
                    : active
                      ? 'border-bh-accent text-bh-accent bg-bh-accent-soft'
                      : 'border-bh-border text-bh-text-dim'
                }`}
                aria-current={active ? 'step' : undefined}
              >
                {done ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : s.n}
              </span>
              <span className={`text-xs font-medium hidden sm:inline ${active ? 'text-bh-text' : 'text-bh-text-dim'}`}>
                {s.label}
              </span>
            </li>
          </React.Fragment>
        )
      })}
    </ol>
  )
}

const FILE_STATUS_STYLE: Record<FileEntry['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'text-bh-text-dim bg-bh-bg-alt' },
  parsing: { label: 'Parsing…', className: 'text-bh-accent bg-bh-accent-soft' },
  ready: { label: 'Ready', className: 'text-bh-success bg-bh-success/10' },
  error: { label: 'Error', className: 'text-bh-danger bg-bh-danger/10' },
}

function FileStatusBadge({ status }: { status: FileEntry['status'] }) {
  const s = FILE_STATUS_STYLE[status]
  return <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 ${s.className}`}>{s.label}</span>
}

function IncludeToggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  const id = React.useId()
  return (
    <div className="inline-flex items-center gap-2 shrink-0">
      <Label htmlFor={id} className="cursor-pointer">Include</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
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

  const reduceMotion = useReducedMotion()
  const stepMotion = {
    initial: { opacity: 0, y: reduceMotion ? 0 : 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reduceMotion ? 0 : -8 },
    transition: { duration: motionTokens.duration.normal, ease: motionTokens.easing.smooth },
  }

  return (
    <div data-testid="sprint-wizard">
      {/* Wizard content stays a focused single column even though the page
          canvas now matches every other dashboard page's width. */}
      <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-bh-accent-soft border border-bh-accent/20 flex items-center justify-center shrink-0">
          <Compass className="w-5 h-5 text-bh-accent" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-bh-text">New sourcing sprint</h1>
          <p className="text-xs text-bh-text-dim">Turn a job description or CV into a ranked shortlist.</p>
        </div>
      </div>

      <SprintStepper current={step} />

      {error && (
        <p className="text-sm text-bh-danger mb-4 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /> {error}
        </p>
      )}

      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div key="step-1" className="glass-panel p-5 space-y-4" {...stepMotion}>
            <div>
              <h2 className="font-semibold text-bh-text">Add job descriptions or CVs</h2>
              <p className="text-xs text-bh-text-dim mt-1">
                Upload up to {MAX_FILES} <code>.txt</code>/<code>.md</code> files, or paste text below — each
                document becomes its own sourcing sprint. On Chrome with built-in AI, parsing happens on-device
                and never leaves your browser. PDF/DOCX support is planned for later.
              </p>
            </div>
            <AIDownloadPrompt />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-2xl border-2 border-dashed border-bh-border hover:border-bh-accent/50 hover:bg-bh-accent-soft/40 transition-colors p-8 flex flex-col items-center gap-2 group"
              data-testid="sprint-file-drop"
            >
              <div className="w-11 h-11 rounded-full bg-bh-accent-soft border border-bh-accent/20 flex items-center justify-center transition-transform group-hover:scale-105">
                <Upload className="w-5 h-5 text-bh-accent" aria-hidden="true" />
              </div>
              <span className="text-sm font-medium text-bh-text">Click to choose files</span>
              <span className="text-xs text-bh-text-dim">.txt or .md — {files.length}/{MAX_FILES} added</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />

            <div className="flex items-end gap-2">
              <Textarea
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                rows={4}
                className="flex-1 resize-none"
                placeholder="…or paste text here"
                data-testid="sprint-jd-input"
              />
              <Button type="button" onClick={addPastedText} variant="secondary" className="shrink-0">
                Add
              </Button>
            </div>

            {files.length > 0 && (
              <ul className="space-y-1.5" data-testid="sprint-file-queue">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 rounded-xl border border-bh-border bg-bh-bg-alt/40 p-2.5 text-sm">
                    <span className="truncate text-bh-text">{f.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <FileStatusBadge status={f.status} />
                      <button type="button" onClick={() => removeFile(f.id)} aria-label={`Remove ${f.name}`} className="p-1 rounded hover:bg-bh-bg-alt">
                        <X className="w-3.5 h-3.5 text-bh-text-dim" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <Button
              type="button"
              onClick={parseAll}
              disabled={parsingAll || files.length === 0}
              className="w-full sm:w-auto"
              data-testid="sprint-parse-button"
            >
              {parsingAll ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Sparkles className="w-4 h-4" aria-hidden="true" />}
              Extract criteria ({files.length})
            </Button>
          </motion.div>
        )}

      {step === 2 && (
          <motion.div key="step-2" className="space-y-4" data-testid="sprint-criteria-step" {...stepMotion}>
          {files.map((f) => (
            <div key={f.id} className="glass-panel p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold text-bh-text truncate">{f.name}</h2>
                <IncludeToggle checked={f.selected} onChange={() => toggleFileSelected(f.id)} />
              </div>
              {f.note && <p className="text-xs text-bh-text-dim">{f.note}</p>}
              <CriteriaFields criteria={f.criteria} onChange={(c) => updateFileCriteria(f.id, c)} />
            </div>
          ))}
          <div className="flex justify-between pt-2">
            <Button type="button" onClick={() => setStep(1)} variant="ghost">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back
            </Button>
            <Button
              type="button"
              onClick={decomposeAll}
              disabled={decomposingAll || selectedFiles.length === 0}
              data-testid="sprint-decompose-button"
            >
              {decomposingAll ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="w-4 h-4" aria-hidden="true" />}
              Propose search variants ({selectedFiles.length})
            </Button>
          </div>
          </motion.div>
      )}

      {step === 3 && (
        <motion.div key="step-3" className="space-y-4" data-testid="sprint-variants-step" {...stepMotion}>
          {drafts.map((draft) => (
            <div key={draft.fileId} className="glass-panel p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Input
                  value={draft.name}
                  onChange={(e) => setDraftName(draft.fileId, e.target.value)}
                  disabled={Boolean(draft.savedSprintId)}
                  className="flex-1 font-medium"
                  data-testid="sprint-name-input"
                />
                {draft.savedSprintId && (
                  <Link
                    to="/sprints/$sprintId"
                    params={{ sprintId: draft.savedSprintId }}
                    className="text-xs text-bh-accent inline-flex items-center gap-1 shrink-0"
                  >
                    <Check className="w-3.5 h-3.5" aria-hidden="true" /> Saved
                  </Link>
                )}
              </div>

              <ul className="space-y-2">
                {draft.variants.map((variant, i) => (
                  <li key={i} className="rounded-xl border border-bh-border bg-bh-bg-alt/40 p-3 text-sm">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={draft.variantSelected[i]}
                        disabled={Boolean(draft.savedSprintId)}
                        onCheckedChange={() => toggleDraftVariant(draft.fileId, i)}
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
                <p className="text-sm text-bh-danger flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /> {draft.error}
                </p>
              )}

              {!draft.savedSprintId && (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => previewDraft(draft.fileId)}
                    disabled={draft.previewing || draft.variantSelected.every((v) => !v)}
                    variant="secondary"
                    size="sm"
                    data-testid="sprint-preview-button"
                  >
                    {draft.previewing ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
                    Preview results
                  </Button>
                  {draft.previewItems != null && (
                    <span className="text-xs text-bh-text-dim" data-testid="sprint-preview-count">
                      {draft.previewItems.length} matching people found (not saved yet)
                    </span>
                  )}
                  <Button
                    type="button"
                    onClick={() => saveDraft(draft.fileId)}
                    disabled={draft.saving || draft.variantSelected.every((v) => !v)}
                    size="sm"
                    className="ml-auto"
                    data-testid="sprint-save-button"
                  >
                    {draft.saving ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
                    Save sprint
                  </Button>
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
            <Button type="button" onClick={() => setStep(2)} variant="ghost">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back
            </Button>
            {allSaved && (
              <Button asChild>
                <Link to="/sprints">Go to sprints</Link>
              </Button>
            )}
          </div>
        </motion.div>
      )}
      </AnimatePresence>
      </div>
    </div>
  )
}

function CriteriaFields({ criteria, onChange }: { criteria: ExtractedCriteria; onChange: (c: ExtractedCriteria) => void }) {
  const skillsId = React.useId()
  const rolesId = React.useId()
  const seniorityId = React.useId()
  const locationsId = React.useId()
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <Label htmlFor={skillsId}>Skills (comma separated)</Label>
        <Input
          id={skillsId}
          value={criteria.skills.join(', ')}
          onChange={(e) => onChange({ ...criteria, skills: toList(e.target.value) })}
          className="mt-1"
          data-testid="sprint-skills-input"
        />
      </div>
      <div>
        <Label htmlFor={rolesId}>Roles (comma separated)</Label>
        <Input
          id={rolesId}
          value={criteria.roles.join(', ')}
          onChange={(e) => onChange({ ...criteria, roles: toList(e.target.value) })}
          className="mt-1"
        />
      </div>
      <div>
        <Label htmlFor={seniorityId}>Seniority</Label>
        <Select
          value={criteria.seniority}
          onValueChange={(value) => onChange({ ...criteria, seniority: value as ExtractedCriteria['seniority'] })}
        >
          <SelectTrigger id={seniorityId} className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unknown">Unknown</SelectItem>
            <SelectItem value="junior">Junior</SelectItem>
            <SelectItem value="mid">Mid</SelectItem>
            <SelectItem value="senior">Senior</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={locationsId}>Locations (comma separated)</Label>
        <Input
          id={locationsId}
          value={criteria.locations.join(', ')}
          onChange={(e) => onChange({ ...criteria, locations: toList(e.target.value) })}
          className="mt-1"
        />
      </div>
    </div>
  )
}
