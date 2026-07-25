import * as React from 'react'
import { ChevronDown, ChevronUp, Mail, Copy, Check, Sparkles, Loader2, Wand2, Scissors } from 'lucide-react'
import { generateOutreach, type OutreachContext, type OutreachDraft, type OutreachTone } from '~/shared/lib/outreach'
import { ai } from '~/shared/lib/ai/client'
import { AIUnavailableError } from '~/shared/lib/ai/errors'
import { getAICapability } from '~/shared/lib/ai/capabilities'
import { useAICapabilities } from '~/shared/lib/ai/useAICapabilities'
import { AIDownloadPrompt } from '~/shared/components/AIDownloadPrompt'
import { Button, Input, Textarea } from '~/components/ui'

interface OutreachCopilotProps {
  builder: OutreachContext['builder']
}

type DraftMode = 'local' | 'server' | 'template'

const MODE_LABEL: Record<DraftMode, string> = {
  local: 'on-device',
  server: 'server AI',
  template: 'template',
}

interface RewriterSession {
  rewrite(text: string): Promise<string>
  destroy?: () => void
}

interface RewriterConstructor {
  create(options: { length?: 'shorter' | 'longer' | 'as-is' }): Promise<RewriterSession>
}

function getRewriter(): RewriterConstructor | null {
  if (typeof window === 'undefined') return null
  const ctor = (globalThis as unknown as { Rewriter?: RewriterConstructor }).Rewriter
  return ctor ?? null
}

const TONES: Array<{ value: OutreachTone; label: string }> = [
  { value: 'casual', label: 'Casual' },
  { value: 'professional', label: 'Professional' },
  { value: 'geek', label: 'Technical deep dive' },
]

export function OutreachCopilot({ builder }: OutreachCopilotProps) {
  const [open, setOpen] = React.useState(false)
  const [jobTitle, setJobTitle] = React.useState('')
  const [company, setCompany] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [tone, setTone] = React.useState<OutreachTone>('professional')
  const [draft, setDraft] = React.useState<OutreachDraft | null>(null)
  const [mode, setMode] = React.useState<DraftMode | null>(null)
  const [modeNote, setModeNote] = React.useState<string | null>(null)
  const [generating, setGenerating] = React.useState(false)
  const [revising, setRevising] = React.useState<'rewrite' | 'shorten' | null>(null)
  const [copied, setCopied] = React.useState(false)
  const { needsDownload } = useAICapabilities()

  const canGenerate = jobTitle.trim().length > 0 && company.trim().length > 0 && !generating

  const buildJob = () => ({
    title: jobTitle.trim(),
    company: company.trim(),
    description: description.trim() || undefined,
  })

  /** Maps an AIUnavailableError to a one-line explanation shown next to the
   * "template" badge — `null` for `disabled` since that's just the platform
   * being off, not something worth surfacing per-draft. */
  const templateReason = (err: unknown): string | null => {
    if (!(err instanceof AIUnavailableError)) return null
    if (err.reason === 'budget') return 'Daily AI limit reached — template draft'
    if (err.reason === 'plan') return 'AI drafting requires a paid plan — template draft'
    return null
  }

  const handleGenerate = async () => {
    if (!canGenerate) return
    setGenerating(true)
    setCopied(false)
    try {
      const result = await ai<OutreachDraft>('outreach-draft', { builder, job: buildJob(), tone })
      setDraft(result.output)
      setMode(result.via)
      setModeNote(null)
    } catch (err) {
      setDraft(generateOutreach({ builder, job: buildJob(), tone }))
      setMode('template')
      setModeNote(templateReason(err))
    } finally {
      setGenerating(false)
    }
  }

  const handleRevise = async (instruction: 'shorten' | 'rewrite') => {
    if (!draft || mode === 'template' || revising) return
    setRevising(instruction)
    try {
      const rewriterCapability = await getAICapability('rewriter')
      const Rewriter = rewriterCapability === 'available' ? getRewriter() : null
      if (Rewriter) {
        const session = await Rewriter.create({ length: instruction === 'shorten' ? 'shorter' : 'as-is' })
        try {
          const revisedBody = await session.rewrite(draft.body)
          setDraft({ ...draft, body: revisedBody.slice(0, 1200) })
          return
        } finally {
          session.destroy?.()
        }
      }
      const result = await ai<OutreachDraft>('outreach-draft', {
        builder,
        job: buildJob(),
        tone,
        revision: { previousBody: draft.body, instruction },
      })
      setDraft(result.output)
      setMode(result.via)
      setModeNote(null)
    } catch {
      // Revision failed on every rung — keep the existing draft rather than
      // losing it. Template drafts never reach here (buttons are hidden).
    } finally {
      setRevising(null)
    }
  }

  const handleCopy = async () => {
    if (!draft) return
    const text = `Subject: ${draft.subject}\n\n${draft.body}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard not available — ignore silently, button just won't tick
    }
  }

  return (
    <div className="card p-5" data-testid="outreach-copilot">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded-lg"
        data-testid="outreach-copilot-toggle"
      >
        <span className="flex items-center gap-2 text-base font-semibold text-bh-text">
          <Mail className="w-4 h-4" aria-hidden="true" />
          Outreach Copilot
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-bh-text-dim" /> : <ChevronDown className="w-4 h-4 text-bh-text-dim" />}
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-bh-text-dim">
            Draft a personalized cold outreach message anchored on this builder's public profile.
            Nothing is sent automatically — review and copy the draft yourself.
          </p>

          {needsDownload && <AIDownloadPrompt />}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              type="text"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
              placeholder="Job title (e.g. Senior Rust Engineer)"
              value={jobTitle}
              onChange={e => setJobTitle(e.target.value)}
              data-testid="outreach-job-title"
            />
            <Input
              type="text"
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
              placeholder="Company name"
              value={company}
              onChange={e => setCompany(e.target.value)}
              data-testid="outreach-company"
            />
          </div>

          <Textarea
            className="w-full resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            rows={2}
            placeholder="Optional: short description of the role"
            value={description}
            onChange={e => setDescription(e.target.value)}
            data-testid="outreach-description"
          />

          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Outreach tone">
            {TONES.map(t => (
              <Button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={tone === t.value}
                onClick={() => setTone(t.value)}
                variant={tone === t.value ? 'secondary' : 'ghost'}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                data-testid={`outreach-tone-${t.value}`}
              >
                {t.label}
              </Button>
            ))}
          </div>

          <Button
            type="button"
            variant="primary"
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            data-testid="outreach-generate"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="w-4 h-4" aria-hidden="true" />
            )}
            {generating ? 'Generating…' : 'Generate draft'}
          </Button>

          {draft && (
            <div
              className="rounded-lg border border-bh-border bg-bh-bg-alt/40 p-4 space-y-2"
              data-testid="outreach-draft"
            >
              <div className="flex items-center justify-between gap-2 pt-0">
                <div className="text-xs text-bh-text-dim uppercase tracking-wider">Subject</div>
                {mode && (
                  <span
                    className="badge inline-flex items-center gap-1 border-bh-accent/30 bg-bh-accent-soft text-bh-accent text-[11px] font-semibold"
                    title={modeNote ?? undefined}
                    data-testid="outreach-mode"
                  >
                    {MODE_LABEL[mode]}
                  </span>
                )}
              </div>
              <div className="text-sm font-medium text-bh-text" data-testid="outreach-draft-subject">
                {draft.subject}
              </div>
              {modeNote && (
                <p className="text-[11px] text-bh-text-dim" data-testid="outreach-mode-note">
                  {modeNote}
                </p>
              )}
              <div className="text-xs text-bh-text-dim uppercase tracking-wider pt-2">Message</div>
              <p className="text-sm text-bh-text whitespace-pre-wrap" data-testid="outreach-draft-body">
                {draft.body}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleCopy}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                  data-testid="outreach-copy"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-bh-success" aria-hidden="true" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" aria-hidden="true" /> Copy to clipboard
                    </>
                  )}
                </Button>
                {mode && mode !== 'template' && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => handleRevise('rewrite')}
                      disabled={revising !== null}
                      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                      data-testid="outreach-rewrite"
                    >
                      {revising === 'rewrite' ? (
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Wand2 className="w-4 h-4" aria-hidden="true" />
                      )}
                      Rewrite
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => handleRevise('shorten')}
                      disabled={revising !== null}
                      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                      data-testid="outreach-shorten"
                    >
                      {revising === 'shorten' ? (
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Scissors className="w-4 h-4" aria-hidden="true" />
                      )}
                      Shorten
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
