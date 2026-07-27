import { useState } from 'react'
import { Button, Checkbox, Input, Label, Textarea } from '~/components/ui'

/**
 * Candidate identity plus the consent controls (plan:
 * calendar-scheduling-interview-intelligence, Phase 5 "Build mobile accountless candidate portal").
 *
 * The consent section is the part of this codebase with the least room for cleverness, so the rules
 * are enforced by the component's shape rather than by discipline:
 *
 * - **Every box starts unticked.** `useState(false)` for each, with no `defaultChecked` and no
 *   "recommended" pre-selection. spec.md: "separate unticked controls".
 * - **There is no `accept all`.** Not as a convenience, not as a secondary control. A single flag is
 *   explicitly not accepted by the API, and offering one in the UI would produce exactly the receipt
 *   the API refuses.
 * - **Each control names its own purpose and notice version.** A candidate ticking a box must be able
 *   to see what they are agreeing to and which version of the text says it, without scrolling to a
 *   footer.
 * - **Declining is expressible.** An unticked box submits `declined`, not "no answer": the ledger
 *   records what the candidate was asked and what they said, and silence is not a decision.
 */

export interface ConsentPurposeCopy {
  purpose: string
  title: string
  description: string
}

/**
 * The candidate-facing wording for each purpose.
 *
 * Deliberately concrete. spec.md requires the notice to say "transient live audio capture and stored
 * transcription", not "recording", and to state that audio is never stored and candidate data is
 * never used for training — a candidate cannot consent to something described in euphemism.
 */
export const CONSENT_COPY: ConsentPurposeCopy[] = [
  {
    purpose: 'terms_and_privacy',
    title: 'Terms of service and privacy notice',
    description: 'I have read the terms and the privacy notice for this interview.',
  },
  {
    purpose: 'candidate_document_processing',
    title: 'Processing documents I upload',
    description: 'Any CV or portfolio file I choose to upload may be scanned for malware, have its text extracted, and be used to prepare this interview.',
  },
  {
    purpose: 'public_web_import',
    title: 'Importing public pages I link to',
    description: 'Public pages I link to may be fetched and their text used to prepare this interview. Only sources with official API access or written permission are fetched.',
  },
  {
    purpose: 'ai_interview_assistance',
    title: 'AI-assisted preparation and reporting',
    description: 'An AI model in the EU may help prepare interview questions and draft the report. My data is never used to train or improve models.',
  },
  {
    purpose: 'live_audio_transcription',
    title: 'Transient live audio capture and stored transcription',
    description: 'During the interview, audio may be streamed to an EU transcription service and the resulting text stored. The audio itself is never stored, by BuilderHunt or by the provider.',
  },
]

export interface CandidateSubmission {
  displayName: string
  email: string
  notes: string
  consentDecisions: { purpose: string; decision: 'accepted' | 'declined' }[]
}

export interface CandidateDetailsFormProps {
  noticeVersion: string
  requiredPurposes: readonly string[]
  submitting?: boolean
  onSubmit: (submission: CandidateSubmission) => void
  /** Rendered above the submit control — a server error the candidate needs to see. */
  error?: string | null
}

export function CandidateDetailsForm({
  noticeVersion,
  requiredPurposes,
  submitting,
  onSubmit,
  error,
}: CandidateDetailsFormProps) {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  // One piece of state per purpose, all false. There is no bulk setter anywhere in this file.
  const [accepted, setAccepted] = useState<Record<string, boolean>>({})

  const missing = requiredPurposes.filter((purpose) => !accepted[purpose])
  const canSubmit = displayName.trim().length > 0 && email.trim().length > 0 && missing.length === 0

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSubmit || submitting) return
        onSubmit({
          displayName: displayName.trim(),
          email: email.trim(),
          notes: notes.trim(),
          // Every purpose gets an explicit decision. An unticked box is a decline on the record, not
          // an absence.
          consentDecisions: CONSENT_COPY.map((copy) => ({
            purpose: copy.purpose,
            decision: accepted[copy.purpose] ? 'accepted' : 'declined',
          })),
        })
      }}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="candidate-name">Your name</Label>
          <Input
            id="candidate-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            autoComplete="name"
            maxLength={200}
          />
        </div>
        <div>
          <Label htmlFor="candidate-email">Your email</Label>
          <Input
            id="candidate-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
          />
          <p className="mt-1 text-xs text-bh-text-muted">
            Used for the confirmation and the calendar invitation. You do not need an account.
          </p>
        </div>
        <div>
          <Label htmlFor="candidate-notes">Anything the interviewer should know (optional)</Label>
          <Textarea
            id="candidate-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={5000}
            rows={3}
          />
        </div>
      </div>

      <fieldset className="space-y-4 rounded-lg border border-bh-border p-4">
        <legend className="px-1 text-sm font-semibold text-bh-text">
          What you are agreeing to
        </legend>
        <p className="text-xs text-bh-text-muted">
          Notice version {noticeVersion}. Each item is a separate decision. You can withdraw any of
          them later, and withdrawing does not cancel your interview.
        </p>
        {CONSENT_COPY.map((copy) => {
          const required = requiredPurposes.includes(copy.purpose)
          return (
            <div key={copy.purpose} className="flex gap-3">
              <Checkbox
                id={`consent-${copy.purpose}`}
                checked={accepted[copy.purpose] ?? false}
                onCheckedChange={(next) =>
                  setAccepted((current) => ({ ...current, [copy.purpose]: next === true }))}
                aria-describedby={`consent-${copy.purpose}-description`}
              />
              <div className="min-w-0">
                <Label htmlFor={`consent-${copy.purpose}`} className="font-medium">
                  {copy.title}
                  {required ? <span className="ml-1 text-bh-text-muted">(required to book)</span> : null}
                </Label>
                <p id={`consent-${copy.purpose}-description`} className="mt-1 text-xs text-bh-text-muted">
                  {copy.description}
                </p>
              </div>
            </div>
          )
        })}
      </fieldset>

      {error ? (
        <p className="text-sm text-bh-danger" role="alert">{error}</p>
      ) : null}

      {missing.length > 0 ? (
        <p className="text-sm text-bh-text-muted" role="status">
          {missing.length} required {missing.length === 1 ? 'decision' : 'decisions'} still to make
          before you can pick a time.
        </p>
      ) : null}

      <Button type="submit" disabled={!canSubmit || submitting} className="w-full">
        {submitting ? 'Saving…' : 'Save and choose a time'}
      </Button>
    </form>
  )
}
