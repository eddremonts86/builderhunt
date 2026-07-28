/**
 * The assertions that matter are absences.
 *
 * There must be no score control, no rating, and no recommendation anywhere in the report editor — not
 * hidden, not disabled, absent. A well-meaning "overall impression" slider is exactly the kind of thing
 * that gets added later, and the API would refuse it while the UI promised it.
 *
 * And the contextual-questions panel must never render a failure reason. The organizer is mid-conversation
 * on a screen the candidate may be able to see.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextualQuestions,
  type ContextualSuggestion,
} from '~/modules/interviews/components/ContextualQuestions'
import {
  InterviewReportEditor,
  messageFor,
  type ReportView,
} from '~/modules/interviews/components/InterviewReportEditor'
import {
  formatOffset,
  TranscriptEvidence,
  TranscriptExcerpt,
  type EvidenceSegment,
} from '~/modules/interviews/components/TranscriptEvidence'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const text = () => container?.textContent ?? ''
const buttons = () => [...(container?.querySelectorAll('button') ?? [])]
const buttonNamed = (pattern: RegExp) => buttons().find((button) => pattern.test(button.textContent ?? ''))
const render = (element: React.ReactNode) => act(() => { root?.render(element) })

const segments: EvidenceSegment[] = [
  { id: 'seg-1', startsMs: 65_000, speakerLabel: 'Candidate', text: 'I rewrote the cache layer.' },
  { id: 'seg-2', startsMs: 184_000, speakerLabel: 'You', text: 'What did that change?' },
]

describe('transcript citations', () => {
  it('labels a citation with its timestamp, never its id', () => {
    render(<TranscriptEvidence segmentIds={['seg-1']} segments={segments} onOpen={() => undefined} />)
    expect(text()).toMatch(/01:05/)
    // A uuid on screen invites someone to quote it in a decision document.
    expect(text()).not.toMatch(/seg-1/)
  })

  it('says what opening a citation does', () => {
    render(<TranscriptEvidence segmentIds={['seg-2']} segments={segments} onOpen={() => undefined} />)
    expect(buttons()[0].getAttribute('aria-label')).toMatch(/Open the transcript at 03:04, You/)
  })

  it('warns visibly when the cited line is gone', () => {
    render(<TranscriptEvidence segmentIds={['seg-deleted']} segments={segments} onOpen={() => undefined} />)
    // The only path here is retention deleting a segment while the report survives. A citation that quietly
    // vanished would make a supported statement look unsupported, and a reader cannot tell those apart.
    expect(text()).toMatch(/Source unavailable/i)
  })

  it('renders nothing for no citations unless given a label', () => {
    render(<TranscriptEvidence segmentIds={[]} segments={segments} onOpen={() => undefined} />)
    expect(text()).toBe('')

    render(
      <TranscriptEvidence segmentIds={[]} segments={segments} onOpen={() => undefined}
        emptyLabel="Not discussed — no transcript to cite." />,
    )
    expect(text()).toMatch(/Not discussed/)
  })

  it('opens the excerpt and says there is no audio', () => {
    render(<TranscriptExcerpt segment={segments[0]} onClose={() => undefined} />)
    expect(text()).toMatch(/I rewrote the cache layer/)
    expect(text()).toMatch(/Candidate · 01:05/)
    // A reader looking for a play button should learn there is nothing to play, not conclude it is broken.
    expect(text()).toMatch(/No audio was kept/i)
  })

  it('formats offsets as mm:ss', () => {
    expect(formatOffset(0)).toBe('00:00')
    expect(formatOffset(65_000)).toBe('01:05')
    expect(formatOffset(3_599_000)).toBe('59:59')
  })
})

const suggestion = (overrides: Partial<ContextualSuggestion> = {}): ContextualSuggestion => ({
  id: 'q1',
  topicId: 'topic:1',
  question: 'What changed about tail latency?',
  rationale: 'They mentioned the rewrite without the outcome.',
  segmentIds: ['seg-1'],
  ...overrides,
})

describe('the contextual questions panel', () => {
  const panel = (overrides: Record<string, unknown> = {}) => render(
    <ContextualQuestions
      suggestions={[suggestion()]}
      source="suggested"
      reason={null}
      segments={segments}
      onAsk={() => undefined}
      onAction={() => undefined}
      {...overrides}
    />,
  )

  it('shows the question, its rationale and its evidence', () => {
    panel()
    expect(text()).toMatch(/What changed about tail latency/)
    expect(text()).toMatch(/without the outcome/)
    // The whole value over a static list is that it responds to something that was said.
    expect(text()).toMatch(/01:05/)
  })

  it('labels a live suggestion differently from a prepared one', () => {
    panel({ source: 'suggested' })
    expect(text()).toMatch(/Based on what was just said/i)

    panel({ source: 'prepared', reason: 'throttled' })
    // A prepared question presented as a live suggestion would make the organizer think the transcript is
    // being read when it is not.
    expect(text()).toMatch(/From your prepared brief/i)
  })

  const quietReasons = ['throttled', 'no_new_speech', 'provider_failed', 'invalid_output', 'ai_disabled', 'no_brief']

  it.each(quietReasons)('says nothing about a %s failure', (reason) => {
    panel({ source: 'prepared', reason })
    const body = text()
    // No banner, no error word, no provider name. The candidate may be able to see this screen.
    expect(body).not.toMatch(/error|failed|unavailable|disabled|throttl/i)
  })

  it('makes an exception only for a plan limit, which the organizer can act on later', () => {
    panel({ source: 'prepared', reason: 'not_entitled' })
    expect(text()).toMatch(/not part of your plan/i)
  })

  it('never shows more than three', () => {
    panel({
      suggestions: [suggestion(), suggestion({ id: 'q2' }), suggestion({ id: 'q3' }), suggestion({ id: 'q4' })],
    })
    expect(container?.querySelectorAll('li')).toHaveLength(3)
  })

  it('reports an explicit action and nothing implicit', () => {
    const actions: Array<[string, string]> = []
    panel({ onAction: (entry: ContextualSuggestion, action: string) => actions.push([entry.id, action]) })
    act(() => { buttonNamed(/I asked this/)?.click() })
    // No "seen" event, no analytics on what was ignored: the proposals are ephemeral by design.
    expect(actions).toEqual([['q1', 'used']])
  })

  it('removes a dismissed question from view', () => {
    panel()
    act(() => { buttons().find((b) => /Dismiss/.test(b.getAttribute('aria-label') ?? ''))?.click() })
    expect(text()).not.toMatch(/What changed about tail latency/)
  })

  it('confirms an action instead of offering it twice', () => {
    panel()
    act(() => { buttonNamed(/Save for later/)?.click() })
    expect(text()).toMatch(/Saved/)
    expect(buttonNamed(/I asked this/)).toBeUndefined()
  })

  it('offers no ask button when the session is not live', () => {
    panel({ onAsk: undefined })
    // The server refuses it anyway, and a button that fails teaches the organizer to distrust the panel.
    expect(buttonNamed(/Suggest from what was said/)).toBeUndefined()
  })

  it('stops the spinner for reduced motion', () => {
    panel({ busy: true })
    expect(container?.querySelector('.animate-spin')?.className).toMatch(/motion-reduce:animate-none/)
  })
})

const report = (overrides: Partial<ReportView> = {}): ReportView => ({
  version: 1,
  status: 'draft',
  content: {
    summary: [{ statement: 'Described a cache rewrite.', segmentIds: ['seg-1'] }],
    answersByTopic: [
      { topicId: 'topic:1', answer: 'Two-stage rollout.', segmentIds: ['seg-1'], status: 'answered' },
      { topicId: 'topic:2', answer: 'Not discussed.', segmentIds: [], status: 'unanswered' },
    ],
    openQuestions: ['How was rollback tested?'],
    followUps: [{ action: 'Ask for the dashboard.', segmentIds: ['seg-2'] }],
  },
  evidenceSegmentIds: ['seg-1', 'seg-2'],
  provider: 'mistral',
  model: 'mistral-medium-2604',
  editedByUserId: null,
  finalizedAt: null,
  ...overrides,
})

describe('the report editor', () => {
  const editor = (overrides: Record<string, unknown> = {}) => render(
    <InterviewReportEditor
      report={report()}
      latestVersion={1}
      segments={segments}
      canEdit
      topicQuestions={{ 'topic:1': 'Explain the rollout.', 'topic:2': 'How was latency measured?' }}
      onGenerate={async () => undefined}
      onSave={async () => undefined}
      onFinalize={async () => undefined}
      {...overrides}
    />,
  )

  it('has no score, rating or recommendation control anywhere', () => {
    editor()
    const body = text().toLowerCase()
    // Absent, not hidden. The schema has no field for one and the server rejects the vocabulary, so a
    // control here would be a promise the API refuses.
    for (const word of ['score', 'rating', 'rank', 'recommend', 'hire', 'reject', 'culture fit']) {
      expect(body).not.toContain(word)
    }
    expect(container?.querySelector('input[type="range"]')).toBeNull()
    expect(container?.querySelector('input[type="number"]')).toBeNull()
    expect(container?.querySelector('select')).toBeNull()
  })

  it('says the record does not score or recommend, before generating one', () => {
    editor({ report: null, latestVersion: null })
    expect(text()).toMatch(/does not score or recommend/i)
  })

  it('states the price on the generate button', () => {
    editor({ report: null, latestVersion: null })
    expect(buttonNamed(/Generate record \(5 credits\)/i)).toBeDefined()
  })

  it('offers no generate button to a participant', () => {
    editor({ report: null, latestVersion: null, canEdit: false })
    expect(buttonNamed(/Generate record/i)).toBeUndefined()
  })

  it('names the model that wrote it', () => {
    editor()
    expect(text()).toMatch(/mistral/)
    expect(text()).toMatch(/Version 1/)
  })

  it('says plainly when no model wrote it', () => {
    editor({ report: report({ provider: null, model: null }) })
    // A blank report presented as generated output would have the organizer trust sections nobody wrote.
    expect(text()).toMatch(/without AI/i)
    expect(text()).toMatch(/fill this in yourself/i)
    expect(text()).not.toMatch(/mistral/)
  })

  it('renders topic questions rather than topic ids', () => {
    editor()
    expect(text()).toMatch(/Explain the rollout/)
    // `topic:2` above an answer tells a reader nothing.
    expect(text()).not.toMatch(/topic:2/)
  })

  it('explains why an unanswered topic cites nothing', () => {
    editor()
    expect(text()).toMatch(/Not discussed — no transcript to cite/)
  })

  it('renders read-only for a participant', () => {
    editor({ canEdit: false })
    expect(container?.querySelector('textarea')).toBeNull()
    expect(buttonNamed(/Finalize record/)).toBeUndefined()
  })

  it('renders read-only once final, and says why', () => {
    editor({ report: report({ status: 'final', finalizedAt: '2027-12-02T10:00:00.000Z' }) })
    expect(text()).toMatch(/final and cannot be changed/i)
    expect(container?.querySelector('textarea')).toBeNull()
    expect(buttonNamed(/Finalize record/)).toBeUndefined()
  })

  it('offers save only after an edit', () => {
    editor()
    expect(buttonNamed(/Save changes/)).toBeUndefined()
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Described a two-stage cache rewrite.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttonNamed(/Save changes/)).toBeDefined()
  })

  it('requires two steps to finalize', () => {
    editor()
    act(() => { buttonNamed(/Finalize record/)?.click() })
    // Named as irreversible on the button itself, not only in a sentence above it.
    expect(buttonNamed(/Yes, finalize permanently/)).toBeDefined()
    expect(buttonNamed(/Cancel/)).toBeDefined()
  })

  it('refuses to finalize over unsaved changes', () => {
    editor()
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Changed.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { buttonNamed(/Finalize record/)?.click() })
    // Finalizing a version that does not include what the organizer just typed would freeze the wrong
    // record.
    expect(text()).toMatch(/Save your changes first/i)
    expect(buttonNamed(/Yes, finalize permanently/)?.disabled).toBe(true)
  })

  it('offers the newer version rather than applying it', () => {
    editor({ report: report({ version: 2 }), latestVersion: 3 })
    expect(text()).toMatch(/newer version \(3\) exists/i)
    expect(text()).toMatch(/Version 2/)
  })

  it('says nothing when the displayed version is the latest', () => {
    editor({ report: report({ version: 3 }), latestVersion: 3 })
    expect(text()).not.toMatch(/newer version/i)
  })

  it('opens a cited transcript line', () => {
    editor()
    act(() => { buttonNamed(/01:05/)?.click() })
    expect(text()).toMatch(/I rewrote the cache layer/)
  })

  it('routes each failure to a sentence the organizer can act on', () => {
    expect(messageFor({ code: 'insufficient_credits' })).toMatch(/costs 5/)
    expect(messageFor({ code: 'dangling_reference' })).toMatch(/Remove it and save again/)
    expect(messageFor({ code: 'version_conflict' })).toMatch(/Reload to see their version/)
    expect(messageFor({ code: 'invalid_content' })).toMatch(/cannot score, rank, or recommend/)
    expect(messageFor({ code: 'already_final' })).toMatch(/already final/)
    expect(messageFor({ code: 'no_transcript' })).toMatch(/no transcript/)
    // Never the server's message: it can echo request details, and these requests carry a transcript.
    expect(messageFor(new Error('column "text" contains: I built the cache'))).toBe(
      'Something went wrong. Nothing was saved.',
    )
  })
})
