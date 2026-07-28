/**
 * The assertions that matter are about what a reader is *told* and what a non-owner is *not offered*.
 *
 * A fallback brief presented as model output is the single most misleading thing this component could do,
 * and a regenerate button shown to a participant teaches them the product is broken when the API refuses
 * it. Both are cheap to get wrong and invisible in a screenshot.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InterviewBriefEditor,
  type BriefView,
} from '~/modules/interviews/components/InterviewBriefEditor'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

const manifest = [
  { id: 'doc:1', kind: 'document' as const, label: 'cv.pdf', text: 'Ten years of Rust.' },
  { id: 'link:1', kind: 'submitted_link' as const, label: 'https://linkedin.com/in/someone' },
]

const brief = (overrides: Partial<BriefView> = {}): BriefView => ({
  version: 2,
  status: 'draft',
  content: {
    candidateSummary: 'Backend engineer.',
    relevantEvidence: [{ claim: 'Ten years of Rust.', sourceIds: ['doc:1'], confidence: 'high' }],
    informationGaps: ['No evidence about leadership.'],
    contradictions: [{ description: 'Dates disagree.', sourceIds: ['doc:1'] }],
    questionGroups: [
      { category: 'critical', question: 'Why the gap?', rationale: 'Dates disagree.', sourceIds: ['doc:1'] },
      { category: 'general', question: 'Tell me about your work.', rationale: 'Opener.', sourceIds: [] },
    ],
  },
  evidenceManifest: manifest,
  provider: 'mistral',
  model: 'mistral-medium-2604',
  editedByUserId: null,
  ...overrides,
})

function render(props: Partial<Parameters<typeof InterviewBriefEditor>[0]> = {}) {
  act(() => {
    root?.render(
      <InterviewBriefEditor
        interviewId="event-1"
        brief={brief()}
        latestVersion={2}
        onChanged={() => undefined}
        canEdit
        {...props}
      />,
    )
  })
}

const text = () => container?.textContent ?? ''
const buttons = () => [...(container?.querySelectorAll('button') ?? [])]
const buttonNamed = (pattern: RegExp) => buttons().find((button) => pattern.test(button.textContent ?? ''))

describe('provenance is shown, never implied', () => {
  it('names the model that wrote it', () => {
    render()
    expect(text()).toMatch(/mistral/)
    expect(text()).toMatch(/Version 2/)
  })

  it('says plainly when no model wrote it', () => {
    // The single most misleading thing this component could do is present a deterministic fallback as
    // model output. A null provider is the fallback's only marker.
    render({ brief: brief({ provider: null, model: null }) })
    expect(text()).toMatch(/without AI/i)
    expect(text()).toMatch(/read the evidence directly/i)
    expect(text()).not.toMatch(/mistral/)
  })

  it('says when a human has edited it', () => {
    render({ brief: brief({ editedByUserId: 'user-1' }) })
    expect(text()).toMatch(/edited by hand/i)
  })
})

describe('a participant reads and is offered nothing to break', () => {
  it('shows no regenerate, accept or save control', () => {
    render({ canEdit: false })
    expect(buttonNamed(/regenerate/i)).toBeUndefined()
    expect(buttonNamed(/use this version/i)).toBeUndefined()
    expect(buttonNamed(/save summary/i)).toBeUndefined()
    // The brief itself is still fully readable — that is the participant's whole purpose here.
    expect(text()).toMatch(/Ten years of Rust/)
  })

  it('renders the summary read-only', () => {
    render({ canEdit: false })
    const textarea = container?.querySelector('textarea')
    expect(textarea?.hasAttribute('readonly')).toBe(true)
  })
})

describe('citations are openable, and labelled by what they are', () => {
  it('renders a source label rather than the raw id', () => {
    render()
    const citation = buttonNamed(/cv\.pdf/)
    expect(citation).toBeDefined()
    // `doc:9f2c…` tells a reader nothing about what they are about to open.
    expect(citation?.getAttribute('aria-label')).toMatch(/Open evidence: cv\.pdf/)
    expect(text()).not.toMatch(/doc:1(?!\d)/)
  })

  it('opens the cited source in the drawer', () => {
    render()
    act(() => { buttonNamed(/cv\.pdf/)?.click() })
    // The extracted text, which is the whole point of forcing every claim to cite something.
    expect(text()).toMatch(/Ten years of Rust\./)
  })

  it('explains a restricted source instead of showing an empty panel', () => {
    render()
    const linkSourceButton = buttons().find((button) => /linkedin\.com/.test(button.textContent ?? ''))
    act(() => { linkSourceButton?.click() })
    expect(text()).toMatch(/terms do not allow us to read it automatically/i)
  })
})

describe('sections render only when they have content', () => {
  it('shows gaps without citations, because absence has no source', () => {
    render()
    expect(text()).toMatch(/What the sources do not say/i)
    expect(text()).toMatch(/No evidence about leadership/)
  })

  it('omits the contradictions heading when there are none', () => {
    render({ brief: brief({ content: { ...brief().content, contradictions: [] } }) })
    expect(text()).not.toMatch(/Contradictions to resolve/i)
  })

  it('groups questions with critical first', () => {
    render()
    const body = text()
    // Lowercase: the headings are uppercased by CSS, which does not change `textContent`.
    // Order matters for a page someone reads minutes before an interview.
    expect(body.indexOf('critical')).toBeGreaterThan(-1)
    expect(body.indexOf('critical')).toBeLessThan(body.indexOf('general'))
  })
})

describe('generation and cost', () => {
  it('offers generation with the price stated when there is no brief', () => {
    render({ brief: null, latestVersion: null })
    expect(buttonNamed(/generate brief \(5 credits\)/i)).toBeDefined()
  })

  it('sends the version it is looking at, so a concurrent generation is refused', async () => {
    render({ brief: null, latestVersion: null })
    await act(async () => { buttonNamed(/generate brief/i)?.click() })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/interviews/event-1/brief')
    // `0` means "there should be none yet"; the confirmation makes an accidental or retried POST not
    // spend five credits.
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 0, creditConfirmation: true })
  })

  it('does not send the manifest when saving an edit', async () => {
    render()
    const textarea = container?.querySelector('textarea')
    await act(async () => {
      if (textarea) {
        // Through the native setter, then a bubbling input event. Assigning `.value` directly does not
        // notify React, so the change handler never runs and the save button never appears — the test
        // would then fail for a reason unrelated to what it claims to check.
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(textarea, 'Corrected.')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    await act(async () => { buttonNamed(/save summary/i)?.click() })

    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    // The manifest is the record of what was actually supplied and read. An editable one would let a
    // citation be pointed at something that was never in evidence.
    expect(Object.keys(body)).not.toContain('evidenceManifest')
    expect((body.content as { candidateSummary: string }).candidateSummary).toBe('Corrected.')
  })

  it('routes an insufficient-credits answer to a sentence about topping up', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'insufficient_credits' }), { status: 402 }))
    render({ brief: null, latestVersion: null })
    await act(async () => { buttonNamed(/generate brief/i)?.click() })
    expect(text()).toMatch(/not have enough AI interview credits/i)
  })

  it('explains a no-evidence refusal rather than showing a generic failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'failed', reason: 'no_evidence' }), { status: 409 }))
    render({ brief: null, latestVersion: null })
    await act(async () => { buttonNamed(/generate brief/i)?.click() })
    expect(text()).toMatch(/nothing readable to build a brief from/i)
  })
})

describe('a newer version is offered, not applied', () => {
  it('says a newer version exists and keeps the current one on screen', () => {
    render({ brief: brief({ version: 2 }), latestVersion: 3 })
    expect(text()).toMatch(/newer version \(3\) exists/i)
    // Loading it silently would discard whatever the organizer is typing.
    expect(text()).toMatch(/still unsaved/i)
    expect(text()).toMatch(/Version 2/)
  })

  it('says nothing when the displayed version is the latest', () => {
    render({ brief: brief({ version: 3 }), latestVersion: 3 })
    expect(text()).not.toMatch(/newer version/i)
  })

  it('offers accept only while the version is not already active', () => {
    render({ brief: brief({ status: 'draft' }) })
    expect(buttonNamed(/use this version/i)).toBeDefined()

    render({ brief: brief({ status: 'active' }) })
    expect(buttonNamed(/use this version/i)).toBeUndefined()
  })
})
