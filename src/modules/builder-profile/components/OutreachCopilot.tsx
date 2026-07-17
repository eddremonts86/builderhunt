import * as React from 'react'
import { ChevronDown, ChevronUp, Mail, Copy, Check, Sparkles } from 'lucide-react'
import { generateOutreach, type OutreachContext, type OutreachDraft, type OutreachTone } from '~/shared/lib/outreach'

interface OutreachCopilotProps {
  builder: OutreachContext['builder']
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
  const [copied, setCopied] = React.useState(false)

  const canGenerate = jobTitle.trim().length > 0 && company.trim().length > 0

  const handleGenerate = () => {
    if (!canGenerate) return
    const result = generateOutreach({
      builder,
      job: {
        title: jobTitle.trim(),
        company: company.trim(),
        description: description.trim() || undefined,
      },
      tone,
    })
    setDraft(result)
    setCopied(false)
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
        className="flex items-center justify-between w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338] focus-visible:ring-offset-2 rounded-lg"
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              className="input-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]"
              placeholder="Job title (e.g. Senior Rust Engineer)"
              value={jobTitle}
              onChange={e => setJobTitle(e.target.value)}
              data-testid="outreach-job-title"
            />
            <input
              type="text"
              className="input-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]"
              placeholder="Company name"
              value={company}
              onChange={e => setCompany(e.target.value)}
              data-testid="outreach-company"
            />
          </div>

          <textarea
            className="input-field w-full resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]"
            rows={2}
            placeholder="Optional: short description of the role"
            value={description}
            onChange={e => setDescription(e.target.value)}
            data-testid="outreach-description"
          />

          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Outreach tone">
            {TONES.map(t => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={tone === t.value}
                onClick={() => setTone(t.value)}
                className={`${tone === t.value ? 'btn-secondary' : 'btn-ghost'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]`}
                data-testid={`outreach-tone-${t.value}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="btn-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]"
            data-testid="outreach-generate"
          >
            <Sparkles className="w-4 h-4" aria-hidden="true" />
            Generate draft
          </button>

          {draft && (
            <div
              className="rounded-lg border border-bh-border bg-bh-bg-alt/40 p-4 space-y-2"
              data-testid="outreach-draft"
            >
              <div className="text-xs text-bh-text-dim uppercase tracking-wider">Subject</div>
              <div className="text-sm font-medium text-bh-text" data-testid="outreach-draft-subject">
                {draft.subject}
              </div>
              <div className="text-xs text-bh-text-dim uppercase tracking-wider pt-2">Message</div>
              <p className="text-sm text-bh-text whitespace-pre-wrap" data-testid="outreach-draft-body">
                {draft.body}
              </p>
              <button
                type="button"
                onClick={handleCopy}
                className="btn-ghost mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e07338]"
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
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
