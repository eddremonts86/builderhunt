/**
 * The assertions that matter are about what an organizer is *told* and what they are *not offered*.
 *
 * Three of them would be invisible in a screenshot and are the difference between a usable feature and a
 * dangerous one: that a browser which cannot capture the meeting is offered notes-only rather than
 * microphone-only transcription, that a diarization guess is never presented as a name, and that a
 * withdrawal reads as a stop rather than a warning.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapturePreflight, messageFor } from '~/modules/interviews/components/CapturePreflight'
import { InterviewControls, describe as describeConnection } from '~/modules/interviews/components/InterviewControls'
import { InterviewNotes, NOTES_AUTOSAVE_DELAY_MS } from '~/modules/interviews/components/InterviewNotes'
import { ANNOUNCE_INTERVAL_MS, LiveTranscript, speakerLabel, type TranscriptSegmentView } from '~/modules/interviews/components/LiveTranscript'
import { SpeakerMapper } from '~/modules/interviews/components/SpeakerMapper'
import { CaptureError, MINIMUM_SUPPORTED_CHROME_MAJOR } from '~/modules/interviews/lib/audio-capture'

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

const CURRENT = MINIMUM_SUPPORTED_CHROME_MAJOR + 1

const consent = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'live_audio_transcription',
  noticeVersion: '2027-09-01.1',
  decidedAt: '2027-08-28T10:00:00.000Z',
  withdrawnAt: null,
  ...overrides,
})

const chromeNavigator = (overrides: Record<string, unknown> = {}) => ({
  userAgentData: { brands: [{ brand: 'Google Chrome', version: String(CURRENT) }], platform: 'macOS', mobile: false },
  mediaDevices: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() },
  ...overrides,
})

describe('the preflight gate', () => {
  const preflight = (overrides: Record<string, unknown> = {}) => render(
    <CapturePreflight
      captureMode="remote_call"
      consent={consent()}
      support={null}
      navigatorLike={chromeNavigator()}
      onReady={() => undefined}
      onManualOnly={() => undefined}
      {...overrides}
    />,
  )

  it('shows the consent receipt with the notice version', () => {
    preflight()
    // Checkable, not reassuring. Naming the version and the date is what makes this a receipt.
    expect(text()).toMatch(/Consent recorded/i)
    expect(text()).toMatch(/2027-09-01\.1/)
  })

  it('refuses to start with no consent on file', () => {
    preflight({ consent: null })
    expect(text()).toMatch(/No consent on file/i)
    expect(buttonNamed(/Share tab and start/i)?.disabled).toBe(true)
  })

  it('refuses to start when consent was withdrawn', () => {
    preflight({ consent: consent({ withdrawnAt: '2027-08-30T09:00:00.000Z' }) })
    expect(text()).toMatch(/Consent was withdrawn/i)
    expect(buttonNamed(/Share tab and start/i)?.disabled).toBe(true)
  })

  it('leaves the verbal-reminder box unticked', () => {
    preflight()
    const box = container?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    // A pre-ticked box records nothing. The point of this control is evidence that a person did something.
    expect(box?.checked).toBe(false)
    expect(buttonNamed(/Share tab and start/i)?.disabled).toBe(true)
  })

  it('enables start only after the reminder is acknowledged', () => {
    preflight()
    const box = container?.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => { box.click() })
    expect(buttonNamed(/Share tab and start/i)?.disabled).toBe(false)
  })

  it('offers notes-only, never microphone-only, on an unsupported browser', () => {
    preflight({
      navigatorLike: chromeNavigator({
        userAgentData: { brands: [{ brand: 'Microsoft Edge', version: String(CURRENT) }], platform: 'Windows', mobile: false },
      }),
    })
    expect(text()).toMatch(/cannot capture a remote call/i)
    expect(text()).toMatch(/notes only/i)
    // The dangerous offer. Half a conversation presented as a whole transcript is worse than none.
    expect(text()).not.toMatch(/microphone only|microphone-only transcription/i)
    expect(buttonNamed(/Share tab and start/i)?.disabled).toBe(true)
  })

  it('distinguishes a platform problem from a browser problem', () => {
    preflight({
      navigatorLike: chromeNavigator({
        userAgentData: { brands: [{ brand: 'Google Chrome', version: String(CURRENT) }], platform: 'Linux', mobile: false },
      }),
    })
    // The remedies differ: one is "use Chrome", the other is "use a desktop".
    expect(text()).toMatch(/desktop Chrome on macOS or Windows/i)
  })

  it('gives the tab-audio instruction, which is how this setup usually fails', () => {
    preflight()
    expect(text()).toMatch(/Also share tab audio/i)
    expect(text()).toMatch(/separate tab/i)
  })

  it('says no audio is stored', () => {
    preflight()
    // The organizer is about to tell the candidate this. It needs to be on the page they are reading.
    expect(text()).toMatch(/No audio is stored/i)
  })

  it('always offers to continue without transcription', () => {
    preflight({ consent: null })
    expect(buttonNamed(/Continue without transcription/i)).toBeDefined()
  })

  it('explains a no-tab-audio failure with the fix', () => {
    expect(messageFor(new CaptureError('x', 'no_tab_audio')))
      .toMatch(/tick "Also share tab audio"/i)
    expect(messageFor(new CaptureError('x', 'not_a_browser_tab'))).toMatch(/Pick the meeting tab/i)
    expect(messageFor(new CaptureError('x', 'self_tab'))).toMatch(/this tab/i)
  })
})

const segment = (n: number, overrides: Partial<TranscriptSegmentView> = {}): TranscriptSegmentView => ({
  id: `seg-${n}`,
  providerSegmentId: `req:0:${n}`,
  sequence: n,
  speakerEstimate: 'speaker_a',
  speakerMapping: null,
  text: `Turn ${n}.`,
  startsMs: n * 60_000,
  endsMs: n * 60_000 + 2_000,
  confidence: 0.9,
  ...overrides,
})

describe('the transcript', () => {
  it('renders finals in sequence order regardless of arrival order', () => {
    render(<LiveTranscript captureMode="remote_call" segments={[segment(3), segment(1)]} interim={null} />)
    const body = text()
    expect(body.indexOf('Turn 1.')).toBeLessThan(body.indexOf('Turn 3.'))
  })

  it('renders interim text as provisional and keeps it out of the list', () => {
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1)]} interim="partial wor" />)
    expect(text()).toMatch(/partial wor/)
    // A separate prop, not an entry in `segments`. There is no state in which an interim line could be
    // persisted by accident.
    expect(container?.querySelectorAll('li')).toHaveLength(2)
    expect(text()).toMatch(/Speaking…/)
  })

  it('keeps the transcript out of the live region', () => {
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1)]} interim={null} />)
    const list = container?.querySelector('ol')
    // A screen reader reading every final as it lands would talk over the candidate for forty-five minutes.
    expect(list?.getAttribute('aria-live')).toBe('off')
    const region = container?.querySelector('[aria-live="polite"]')
    expect(region?.className).toMatch(/sr-only/)
  })

  it('announces a summary, not the words', () => {
    const clock = 1_000_000
    render(<LiveTranscript captureMode="remote_call" segments={[]} interim={null} now={() => clock} />)
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1)]} interim={null} now={() => clock} />)
    const region = container?.querySelector('[aria-live="polite"]')
    expect(region?.textContent).toMatch(/1 new transcript line/i)
    // The candidate's words are on screen, not in the ear of someone trying to listen to them.
    expect(region?.textContent).not.toMatch(/Turn 1/)
  })

  it('throttles announcements', () => {
    let clock = 1_000_000
    render(<LiveTranscript captureMode="remote_call" segments={[]} interim={null} now={() => clock} />)
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1)]} interim={null} now={() => clock} />)
    clock += 1_000
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1), segment(2)]} interim={null} now={() => clock} />)
    // Still the first announcement: one second later is inside the window.
    expect(container?.querySelector('[aria-live="polite"]')?.textContent).toMatch(/1 new/)

    clock += ANNOUNCE_INTERVAL_MS
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1), segment(2), segment(3)]} interim={null} now={() => clock} />)
    expect(container?.querySelector('[aria-live="polite"]')?.textContent).toMatch(/2 new/)
  })

  it('says why it is not growing when transcription is off', () => {
    render(<LiveTranscript captureMode="remote_call" segments={[]} interim={null} manualOnlyReason="unsupported" />)
    // An empty panel with no explanation reads as a broken feature.
    expect(text()).toMatch(/Not transcribing this interview/i)
    expect(text()).toMatch(/notes are still saved/i)
  })

  it('says capture is paused', () => {
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1)]} interim={null} paused />)
    expect(text()).toMatch(/Capture is paused/i)
  })

  it('offers per-line correction only for in-person', () => {
    render(<LiveTranscript captureMode="remote_call" segments={[segment(1)]} interim={null} onCorrectSpeaker={() => undefined} />)
    expect(buttonNamed(/^You$/)).toBeUndefined()

    render(<LiveTranscript captureMode="in_person" segments={[segment(1)]} interim={null} onCorrectSpeaker={() => undefined} />)
    // Remote attribution is a fact the mixer constructed. Offering to correct it teaches distrust.
    expect(buttonNamed(/^You$/)).toBeDefined()
  })

  it('reports a correction with the segment id and mapping', () => {
    const corrections: Array<[string, string]> = []
    render(
      <LiveTranscript
        captureMode="in_person"
        segments={[segment(1)]}
        interim={null}
        onCorrectSpeaker={(id, mapping) => corrections.push([id, mapping])}
      />,
    )
    act(() => { buttonNamed(/^Candidate$/)?.click() })
    expect(corrections).toEqual([['seg-1', 'candidate_or_remote']])
  })
})

describe('speaker labels', () => {
  it('names remote speakers, because the channel is a fact', () => {
    expect(speakerLabel({ speakerEstimate: 'speaker_a', speakerMapping: null }, 'remote_call')).toBe('You')
    expect(speakerLabel({ speakerEstimate: 'speaker_b', speakerMapping: null }, 'remote_call')).toBe('Candidate')
  })

  it('admits an in-person guess is a guess', () => {
    // "Speaker A", not "You". Presenting a diarization label as a name lets a reader attribute a sentence
    // to the wrong person with no way to tell.
    expect(speakerLabel({ speakerEstimate: 'speaker_a', speakerMapping: null }, 'in_person')).toBe('Speaker A')
    expect(speakerLabel({ speakerEstimate: 'speaker_b', speakerMapping: null }, 'in_person')).toBe('Speaker B')
  })

  it('lets a confirmed mapping override the estimate in both modes', () => {
    expect(speakerLabel({ speakerEstimate: 'speaker_a', speakerMapping: 'candidate_or_remote' }, 'remote_call')).toBe('Candidate')
    expect(speakerLabel({ speakerEstimate: 'speaker_b', speakerMapping: 'organizer' }, 'in_person')).toBe('You')
  })

  it('says unattributed rather than picking one', () => {
    expect(speakerLabel({ speakerEstimate: 'unknown', speakerMapping: null }, 'in_person')).toBe('Unattributed')
    expect(speakerLabel({ speakerEstimate: 'unknown', speakerMapping: null }, 'remote_call')).toBe('Unattributed')
  })
})

describe('the speaker mapper', () => {
  const mapper = (overrides: Record<string, unknown> = {}) => render(
    <SpeakerMapper
      captureMode="in_person"
      segments={[segment(1), segment(2, { speakerEstimate: 'speaker_b' })]}
      onMapAll={() => undefined}
      {...overrides}
    />,
  )

  it('renders nothing for a remote interview', () => {
    mapper({ captureMode: 'remote_call' })
    expect(text()).toBe('')
  })

  it('renders nothing before any speaker has been heard', () => {
    mapper({ segments: [] })
    expect(text()).toBe('')
  })

  it('offers both voices with a line count', () => {
    mapper()
    expect(text()).toMatch(/Speaker A/)
    expect(text()).toMatch(/Speaker B/)
    expect(text()).toMatch(/1 lines/)
  })

  it('says plainly that these are guesses', () => {
    mapper()
    // Honest about the limitation. Pretending one microphone can tell two voices apart puts words in the
    // wrong person's mouth.
    expect(text()).toMatch(/best guess/i)
  })

  it('applies a mapping to a whole voice at once', () => {
    const calls: Array<[string, string]> = []
    mapper({ onMapAll: (estimate: string, mapping: string) => calls.push([estimate, mapping]) })
    act(() => { buttonNamed(/This is me/)?.click() })
    // Diarization is consistently wrong rather than randomly wrong, so the useful correction is per voice.
    expect(calls).toEqual([['speaker_a', 'organizer']])
  })

  it('surfaces unattributed lines rather than folding them into a speaker', () => {
    mapper({ segments: [segment(1), segment(2, { speakerEstimate: 'unknown' })] })
    expect(text()).toMatch(/1 line could not be attributed/i)
  })

  it('shows which mapping is already set', () => {
    mapper({ segments: [segment(1, { speakerMapping: 'organizer' })] })
    const pressed = buttons().find((button) => button.getAttribute('aria-pressed') === 'true')
    expect(pressed?.textContent).toMatch(/This is me/)
  })
})

describe('the controls', () => {
  const controls = (overrides: Record<string, unknown> = {}) => render(
    <InterviewControls
      state="live"
      connection="open"
      elapsedMs={12 * 60_000 + 4_000}
      remainingCredits={120}
      withdrawn={false}
      onPause={() => undefined}
      onResume={() => undefined}
      onFinish={() => undefined}
      onReconnect={() => undefined}
      {...overrides}
    />,
  )

  it('shows the clock and a spoken duration for a screen reader', () => {
    controls()
    expect(text()).toMatch(/12:04/)
    // "12:04" is read as a time of day. A duration has to be spelled out.
    expect(container?.querySelector('[aria-label*="12 minutes"]')).not.toBeNull()
  })

  it('names a reconnect instead of showing a green dot', () => {
    controls({ connection: 'reconnecting' })
    // An organizer who believes they have a transcript and does not is what this prevents.
    expect(text()).toMatch(/Reconnecting/)
    expect(describeConnection('reconnecting').label).toBe('Reconnecting')
    expect(describeConnection('open').label).toBe('Transcribing')
    expect(describeConnection('failed').label).toBe('Not transcribing')
    expect(describeConnection('manual_only').label).toBe('Notes only')
  })

  it('stops the spinner for a reduced-motion preference', () => {
    controls({ connection: 'connecting' })
    const spinner = container?.querySelector('.animate-spin')
    // A spinner that keeps moving for a user who asked for less motion is the exact thing the preference
    // exists to stop.
    expect(spinner?.className).toMatch(/motion-reduce:animate-none/)
  })

  it('warns about a low balance without blocking the page', () => {
    controls({ remainingCredits: 8 })
    expect(text()).toMatch(/8 minutes of transcription left/i)
    // Not a modal. The organizer is talking to someone.
    expect(text()).toMatch(/interview continues/i)
    expect(container?.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not warn at a healthy balance', () => {
    controls({ remainingCredits: 120 })
    expect(text()).not.toMatch(/minutes of transcription left/i)
  })

  it('shows no credit line at all in manual-only', () => {
    controls({ remainingCredits: null, connection: 'manual_only' })
    expect(text()).not.toMatch(/credits? left/i)
  })

  it('makes a withdrawal an alert and removes pause', () => {
    controls({ withdrawn: true })
    const alert = container?.querySelector('[role="alert"]')
    expect(alert?.textContent).toMatch(/withdrawn consent/i)
    // Finish is the only forward action, so ignoring the stop cannot happen by accident.
    expect(buttonNamed(/Pause/)).toBeUndefined()
    expect(buttonNamed(/Finish interview/)).toBeDefined()
  })

  it('offers resume only while paused', () => {
    controls({ state: 'live' })
    expect(buttonNamed(/Resume/)).toBeUndefined()
    controls({ state: 'paused' })
    expect(buttonNamed(/Resume/)).toBeDefined()
    expect(buttonNamed(/Pause/)).toBeUndefined()
  })

  it('offers reconnect only when the provider gave up', () => {
    controls({ connection: 'open' })
    expect(buttonNamed(/Reconnect/)).toBeUndefined()
    controls({ connection: 'failed' })
    expect(buttonNamed(/Reconnect/)).toBeDefined()
  })

  it('hides finish once the session is terminal', () => {
    controls({ state: 'processing' })
    expect(buttonNamed(/Finish interview/)).toBeUndefined()
  })
})

describe('the notes panel', () => {
  it('says the notes are private and not in the transcript', () => {
    render(<InterviewNotes notes="" markers={[]} elapsedMs={0} onSaveNotes={async () => undefined} onAddMarker={() => undefined} />)
    // An organizer needs to know where the boundary is before they type an impression into it.
    expect(text()).toMatch(/Only you can see these/i)
    expect(text()).toMatch(/not part of the transcript/i)
  })

  it('autosaves after the debounce and reports it', async () => {
    vi.useFakeTimers()
    const saved: string[] = []
    render(
      <InterviewNotes
        notes="" markers={[]} elapsedMs={0}
        onSaveNotes={async (value) => { saved.push(value) }}
        onAddMarker={() => undefined}
      />,
    )
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Strong on caching.')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(saved).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTES_AUTOSAVE_DELAY_MS + 10) })
    expect(saved).toEqual(['Strong on caching.'])
    expect(text()).toMatch(/Saved/)
    vi.useRealTimers()
  })

  it('says so when a save fails', async () => {
    vi.useFakeTimers()
    render(
      <InterviewNotes
        notes="" markers={[]} elapsedMs={0}
        onSaveNotes={async () => { throw new Error('offline') }}
        onAddMarker={() => undefined}
      />,
    )
    const textarea = container?.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'x')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(NOTES_AUTOSAVE_DELAY_MS + 10) })
    // An organizer whose notes silently failed to save discovers it after the interview, when the notes
    // are the only record of what they thought.
    expect(text()).toMatch(/Not saved/)
    vi.useRealTimers()
  })

  it('adds a marker at the current offset', () => {
    const marks: number[] = []
    render(
      <InterviewNotes notes="" markers={[]} elapsedMs={124_000}
        onSaveNotes={async () => undefined} onAddMarker={(at) => marks.push(at)} />,
    )
    act(() => { buttonNamed(/Mark this moment/)?.click() })
    expect(marks).toEqual([124_000])
  })

  it('lists markers as offsets, never as copied transcript text', () => {
    render(
      <InterviewNotes
        notes="" elapsedMs={0}
        markers={[{ id: 'm2', atMs: 180_000, label: 'Come back to this' }, { id: 'm1', atMs: 60_000, label: 'Good answer' }]}
        onSaveNotes={async () => undefined} onAddMarker={() => undefined}
      />,
    )
    const body = text()
    // Sorted by time, and a pointer rather than a copy — duplicating a candidate's words into a second
    // store with its own retention buys nothing.
    expect(body.indexOf('01:00')).toBeLessThan(body.indexOf('03:00'))
    expect(body).toMatch(/Good answer/)
  })
})
