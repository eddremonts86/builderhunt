/**
 * The workspace as a whole: preflight → capture → withdrawal → finish.
 *
 * Every side effect is injected — the API, the media devices, the socket, the audio graph — because the
 * behaviours worth asserting are sequencing ones. Whether the socket closes before the mixer stops, whether
 * a withdrawal tears capture down without waiting for a click, whether a finish flushes the outbox *before*
 * the session stops accepting segments: all invisible unless the doubles record order.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LiveInterviewPage,
  readableError,
  type LiveInterviewApi,
  type SessionDto,
} from '~/modules/interviews/components/LiveInterviewPage'
import { MINIMUM_SUPPORTED_CHROME_MAJOR } from '~/modules/interviews/lib/audio-capture'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const CURRENT = MINIMUM_SUPPORTED_CHROME_MAJOR + 1

let container: HTMLDivElement | null = null
let root: Root | null = null
/** Everything either double touches, in the order it happened. */
let trace: string[] = []

function fakeTrack(kind: 'audio' | 'video') {
  return {
    kind,
    label: kind === 'video' ? 'Meet — Interview' : 'microphone',
    readyState: 'live',
    stop: () => { trace.push(`stop:${kind}`) },
    getSettings: () => ({ displaySurface: 'browser' }),
  }
}

function fakeStream(kinds: Array<'audio' | 'video'>): MediaStream {
  const list = kinds.map(fakeTrack)
  return {
    getTracks: () => list,
    getAudioTracks: () => list.filter((entry) => entry.kind === 'audio'),
    getVideoTracks: () => list.filter((entry) => entry.kind === 'video'),
    removeTrack: (target: unknown) => {
      const at = list.indexOf(target as ReturnType<typeof fakeTrack>)
      if (at >= 0) list.splice(at, 1)
    },
  } as unknown as MediaStream
}

const navigatorLike = () => ({
  userAgentData: { brands: [{ brand: 'Google Chrome', version: String(CURRENT) }], platform: 'macOS', mobile: false },
  mediaDevices: {
    getUserMedia: async () => fakeStream(['audio']),
    getDisplayMedia: async () => fakeStream(['video', 'audio']),
  },
})

const session = (overrides: Partial<SessionDto> = {}): SessionDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  state: 'not_started',
  captureMode: 'remote_call',
  language: 'en',
  startedAt: null,
  version: 1,
  canControl: true,
  ...overrides,
})

function fakeApi(overrides: Partial<LiveInterviewApi> = {}) {
  const state = { current: session() }
  const sent: unknown[][] = []
  const api: LiveInterviewApi = {
    createSession: async () => {
      trace.push('createSession')
      state.current = session({ state: 'consent_pending', version: 2 })
      return state.current
    },
    markReady: async () => {
      trace.push('markReady')
      state.current = session({ state: 'ready', version: 3 })
      return state.current
    },
    goLive: async () => {
      trace.push('goLive')
      state.current = session({ state: 'live', version: 4, startedAt: '2027-09-01T10:00:00.000Z' })
      return { session: state.current, reservedUnits: 180 }
    },
    pause: async () => {
      trace.push('pause')
      state.current = session({ state: 'paused', version: 5, startedAt: '2027-09-01T10:00:00.000Z' })
      return state.current
    },
    resume: async () => {
      trace.push('resume')
      state.current = session({ state: 'live', version: 6, startedAt: '2027-09-01T10:00:00.000Z' })
      return state.current
    },
    finish: async () => {
      trace.push('finish')
      state.current = session({ state: 'processing', version: 7 })
      return state.current
    },
    heartbeat: async () => {
      trace.push('heartbeat')
      return { action: 'continue' as const, session: state.current }
    },
    readSession: async () => ({ session: state.current, stopNow: false }),
    mintToken: async () => {
      trace.push('mintToken')
      return {
        accessToken: 'grant-1',
        url: 'wss://api.eu.deepgram.com/v1/listen',
        parameters: { model: 'nova-3', channels: '2', multichannel: 'true' },
      }
    },
    sendSegments: async (segments) => {
      trace.push(`sendSegments:${segments.length}`)
      sent.push([...segments])
      return { accepted: segments.map((entry) => entry.providerSegmentId), inserted: segments.length }
    },
    correctSpeaker: async () => { trace.push('correctSpeaker') },
    saveNotes: async () => { trace.push('saveNotes') },
    ...overrides,
  }
  return { api, sent, state }
}

beforeEach(() => {
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  trace = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // happy-dom has neither, and the mixer only reaches them through the injected factory in unit tests —
  // but `createAudioMixer`'s default path is what the page uses, so a constructor has to exist.
  ;(globalThis as { AudioContext?: unknown }).AudioContext = class {
    sampleRate = 16_000
    destination = { connect: () => undefined, disconnect: () => undefined }
    createMediaStreamSource() { return { connect: () => undefined, disconnect: () => undefined } }
    createChannelMerger() { return { connect: () => undefined, disconnect: () => undefined } }
    createScriptProcessor() {
      return { onaudioprocess: null, connect: () => undefined, disconnect: () => undefined }
    }
    close() { trace.push('closeContext'); return Promise.resolve() }
  }
  ;(globalThis as { WebSocket?: unknown }).WebSocket = class {
    static OPEN = 1
    readyState = 1
    binaryType = 'arraybuffer'
    onopen: (() => void) | null = null
    onclose: ((event: { code?: number }) => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    constructor() {
      trace.push('openSocket')
      // Asynchronously, as a browser does: an `onopen` fired from the constructor would run before the
      // client had assigned its handler.
      queueMicrotask(() => this.onopen?.())
    }
    send() { trace.push('send') }
    close() { trace.push('closeSocket') }
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

const text = () => container?.textContent ?? ''
const buttons = () => [...(container?.querySelectorAll('button') ?? [])]
const buttonNamed = (pattern: RegExp) => buttons().find((button) => pattern.test(button.textContent ?? ''))

const consent = {
  purpose: 'live_audio_transcription',
  noticeVersion: '2027-09-01.1',
  decidedAt: '2027-08-28T10:00:00.000Z',
  withdrawnAt: null,
}

async function mount(api: LiveInterviewApi, overrides: Record<string, unknown> = {}) {
  await act(async () => {
    root?.render(
      <LiveInterviewPage
        interviewId="event-1"
        userId="user-a"
        captureMode="remote_call"
        language="en"
        consent={consent}
        session={null}
        brief={<p>Brief goes here</p>}
        api={api}
        navigatorLike={navigatorLike()}
        pollIntervalMs={50}
        now={() => new Date('2027-09-01T10:12:04.000Z').getTime()}
        {...overrides}
      />,
    )
  })
}

/**
 * Lets the pending chain settle.
 *
 * A single microtask is not enough: opening the outbox is IndexedDB, which needs real event-loop turns, and
 * the start chain is createSession → markReady → goLive → openOutbox → connect → mintToken → socket. A test
 * that flushed once would assert on a half-finished startup and read as a missing socket.
 */
async function settle(turns = 6) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
  }
}

/** Ticks the verbal-reminder box and presses start, which is the only way capture begins. */
async function startCapture() {
  const box = container?.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => { box.click() })
  await act(async () => { buttonNamed(/Share tab and start/i)?.click() })
  await settle()
}

/** Asserts the labels appear in this relative order, ignoring whatever else happened between them. */
function expectOrder(labels: readonly string[]) {
  const positions = labels.map((label) => trace.indexOf(label))
  for (const [index, position] of positions.entries()) {
    expect(position, `${labels[index]} missing from ${JSON.stringify(trace)}`).toBeGreaterThanOrEqual(0)
    if (index > 0) expect(position, `${labels[index]} before ${labels[index - 1]}`).toBeGreaterThan(positions[index - 1])
  }
}

describe('the preflight is the only door', () => {
  it('renders the preflight before any capture', async () => {
    const { api } = fakeApi()
    await mount(api)
    expect(text()).toMatch(/Before you start/i)
    // Nothing acquired, nothing created, no socket. A page that provisioned on mount would hold a
    // microphone for an interview the organizer had not started.
    expect(trace).toEqual([])
  })

  it('renders the brief alongside it', async () => {
    const { api } = fakeApi()
    await mount(api)
    expect(text()).toMatch(/Brief goes here/)
  })

  it('walks create → ready → live and opens the socket', async () => {
    const { api } = fakeApi()
    await mount(api)
    await startCapture()
    // The token is minted before the socket opens, and the reservation is taken before either. Asserted as
    // an order rather than an exact list, because `requestCapture` stops the throwaway video track first
    // and that is correct.
    expectOrder(['createSession', 'markReady', 'goLive', 'mintToken', 'openSocket'])
  })

  it('shows the transcript and controls once live', async () => {
    const { api } = fakeApi()
    await mount(api)
    await startCapture()
    expect(text()).not.toMatch(/Before you start/i)
    expect(buttonNamed(/Finish interview/i)).toBeDefined()
    expect(text()).toMatch(/Transcript/i)
  })

  it('drops to notes-only when the organizer declines', async () => {
    const { api } = fakeApi()
    await mount(api)
    await act(async () => { buttonNamed(/Continue without transcription/i)?.click() })
    expect(text()).toMatch(/Not transcribing this interview/i)
    // Nothing was acquired or reserved.
    expect(trace).toEqual([])
  })
})

describe('a failure to start never ends the interview', () => {
  it('drops to notes-only when credits are refused', async () => {
    const { api } = fakeApi({
      goLive: async () => { throw Object.assign(new Error('x'), { code: 'insufficient_credits' }) },
    })
    await mount(api)
    await startCapture()
    // The organizer is mid-conversation with a real person. A page that ended the session here would be a
    // worse product than one that keeps taking notes.
    expect(text()).toMatch(/Not enough credits/i)
    expect(text()).toMatch(/Not transcribing this interview/i)
    expect(buttonNamed(/Finish interview/i)).toBeDefined()
  })

  it('drops to notes-only when the token is refused', async () => {
    const { api } = fakeApi({
      mintToken: async () => { throw Object.assign(new Error('x'), { code: 'consent_withdrawn' }) },
    })
    await mount(api)
    await startCapture()
    expect(text()).toMatch(/withdrew consent/i)
    expect(text()).toMatch(/Not transcribing/i)
  })

  it('says nothing about the server message, only the code', () => {
    // A server message can echo request details, and these requests carry a candidate's transcript.
    expect(readableError({ code: 'version_conflict' })).toMatch(/another tab/i)
    expect(readableError(new Error('column "transcript" contains: I built the cache'))).toBe(
      'Something went wrong. Your notes are still saved.',
    )
  })

  it('prefers the wrapped reason over the wrapper code', () => {
    // A `DeepgramClientError` reports `no_token` for a withdrawal, a spent balance and a network fault
    // alike. Reading only `code` told the organizer "something went wrong" at the one moment they needed
    // to know exactly what had happened.
    expect(readableError({ code: 'no_token', reason: 'consent_withdrawn' })).toMatch(/withdrew consent/i)
    expect(readableError({ code: 'no_token', reason: 'insufficient_credits' })).toMatch(/Not enough credits/i)
    expect(readableError({ code: 'no_token', reason: null })).toMatch(/could not restart/i)
  })
})

describe('the withdrawal path', () => {
  it('tears capture down from the poll, without waiting for a click', async () => {
    const { api } = fakeApi({
      heartbeat: async () => {
        trace.push('heartbeat')
        return { action: 'stop_now' as const, session: session({ state: 'live', version: 4, startedAt: '2027-09-01T10:00:00.000Z' }) }
      },
    })
    await mount(api)
    await startCapture()
    trace = []

    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 80) }) })
    await settle()

    // The socket first, then the microphone. Reversing it delivers frames to a closed socket.
    const closeSocketAt = trace.indexOf('closeSocket')
    const stopAudioAt = trace.indexOf('stop:audio')
    expect(closeSocketAt).toBeGreaterThanOrEqual(0)
    expect(stopAudioAt).toBeGreaterThan(closeSocketAt)
    expect(text()).toMatch(/withdrawn consent/i)
  })

  it('leaves finish as the only forward action', async () => {
    const { api } = fakeApi({
      heartbeat: async () => ({
        action: 'stop_now' as const,
        session: session({ state: 'live', version: 4, startedAt: '2027-09-01T10:00:00.000Z' }),
      }),
    })
    await mount(api)
    await startCapture()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 80) }) })
    await settle(2)

    expect(buttonNamed(/Pause/)).toBeUndefined()
    expect(buttonNamed(/Finish interview/)).toBeDefined()
  })
})

describe('pause and resume', () => {
  it('stops capture on pause, so nothing is transcribed while it says paused', async () => {
    const { api } = fakeApi()
    await mount(api)
    await startCapture()
    trace = []
    await act(async () => { buttonNamed(/Pause/)?.click() })
    await settle()

    // The socket closes before the transition is requested. A pause that only changed a label would keep
    // transcribing audio the organizer believes is not being captured.
    expect(trace.indexOf('closeSocket')).toBeLessThan(trace.indexOf('pause'))
    expect(text()).toMatch(/Capture is paused/i)
  })
})

describe('finishing', () => {
  it('flushes the outbox before the session stops accepting segments', async () => {
    const { api } = fakeApi()
    await mount(api)
    await startCapture()
    trace = []
    await act(async () => { buttonNamed(/Finish interview/)?.click() })
    await settle()

    // Capture down, buffered text sent, and only then the transition. Finishing first would make the
    // append endpoint refuse the last segments of the interview.
    expect(trace.indexOf('closeSocket')).toBeLessThan(trace.indexOf('finish'))
    expect(text()).not.toMatch(/Finish interview/)
  })

  it('reports a version conflict as something the organizer can act on', async () => {
    const { api } = fakeApi({
      finish: async () => { throw Object.assign(new Error('x'), { code: 'version_conflict' }) },
    })
    await mount(api)
    await startCapture()
    await act(async () => { buttonNamed(/Finish interview/)?.click() })
    await settle()
    expect(text()).toMatch(/changed in another tab/i)
  })
})

describe('the layout holds at 320 px', () => {
  it('stacks in one column and lets no child force a sideways scroll', async () => {
    const { api } = fakeApi()
    await mount(api)
    const grid = container?.firstElementChild
    // One column below `md`, and `min-w-0` on both children: without it a long transcript line makes the
    // whole page scroll horizontally on a phone.
    expect(grid?.className).toMatch(/md:grid-cols-/)
    expect(grid?.className).not.toMatch(/^grid-cols-2/)
    const columns = [...(grid?.children ?? [])]
    expect(columns.length).toBe(2)
    for (const column of columns) expect(column.className).toMatch(/min-w-0/)
  })
})
