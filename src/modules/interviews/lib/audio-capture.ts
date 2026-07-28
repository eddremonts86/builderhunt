/**
 * Browser audio capture and the two-channel mixer (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## Nothing here can record
 *
 * There is no `MediaRecorder`, no `Blob`, no `createObjectURL`, no `<audio>` or `<video>` element, and no
 * path by which a sample could become a file. Audio exists as `Float32Array` frames inside an
 * `AudioContext` for as long as it takes to convert them to PCM and hand them to a socket, and then it is
 * gone. `tests/unit/modules/interviews/lib/audio-capture.test.ts` asserts the absence statically, because
 * a comment promising it would not survive a well-meaning refactor.
 *
 * The consent a candidate gives is for transient live transcription. A recording — even a temporary one in
 * memory that could be saved — would make that consent inaccurate.
 *
 * ## Remote capture needs a *separate* meeting tab, and the video track dies immediately
 *
 * `getDisplayMedia` cannot return audio alone; the spec requires a video track. So one is requested, and
 * `stop()`ed before the provider socket is opened — not after, not on teardown. A video track alive during
 * a connection is a video track that could be attached to something, and the ordering is asserted rather
 * than assumed.
 *
 * The share must be a *browser tab* (`displaySurface === 'browser'`) and it must not be this tab. A
 * monitor or window share would capture every notification sound and every other conversation on the
 * machine; sharing this tab would feed the transcript back into itself.
 *
 * ## Channel 0 is the organizer, channel 1 is the meeting. Deterministically.
 *
 * The mixer puts them there. That is why remote mode uses `multichannel` and not diarization — attribution
 * is a fact we constructed, not a guess a model made. In-person has one microphone carrying two voices, so
 * there is nothing to construct and diarization is the only option.
 *
 * A remote session that cannot get two channels degrades to **manual-only**, never to microphone-only
 * transcription. A transcript of an interview with the candidate's half missing is worse than no
 * transcript: it reads as complete, and nobody can tell which half is absent.
 */

/**
 * The oldest Chrome major this feature supports.
 *
 * spec.md asks for "current and previous stable". Code cannot know what today's current is, so this is a
 * floor that has to be raised deliberately — `docs/operations/interview-runtime-verification.md` owns the
 * schedule. A floor that drifts is a floor that eventually admits a browser nobody tested; one that is
 * never raised is one that keeps a bug report alive for a version we no longer verify.
 */
export const MINIMUM_SUPPORTED_CHROME_MAJOR = 138

export const SAMPLE_RATE = 16_000
/** 20 ms at 16 kHz. Small enough that a final segment is not delayed, large enough not to thrash the socket. */
export const FRAME_SAMPLES = 320

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unsupported_browser'
      | 'unsupported_platform'
      | 'requires_user_gesture'
      | 'permission_denied'
      | 'no_microphone'
      | 'not_a_browser_tab'
      | 'self_tab'
      | 'no_tab_audio'
      | 'mixer_unavailable',
    /** True when the organizer can still take notes and transcribe nothing. */
    readonly manualOnly = false,
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

export interface BrowserIdentity {
  browserName: string
  browserMajor: number
  platform: 'macos' | 'windows' | 'other'
  mobile: boolean
}

interface UserAgentBrand { brand: string; version: string }

/**
 * Identifies the browser from `userAgentData` where it exists, falling back to the UA string.
 *
 * `userAgentData` is preferred because it reports the *brand* rather than a string every browser has spent
 * two decades lying in. The fallback exists for the browsers that do not implement it — all of which this
 * feature will refuse anyway, which is precisely why identifying them correctly matters: a Safari user
 * needs to be told to use Chrome, not shown a generic failure.
 */
export function identifyBrowser(navigatorLike: {
  userAgent?: string
  userAgentData?: { brands?: UserAgentBrand[]; platform?: string; mobile?: boolean }
}): BrowserIdentity {
  const data = navigatorLike.userAgentData
  if (data?.brands?.length) {
    // "Google Chrome" specifically. Every Chromium browser puts "Chromium" in this list, and Edge, Brave
    // and Opera all add their own — matching "Chromium" would admit browsers whose display-capture
    // behaviour we have not verified.
    const chrome = data.brands.find((brand) => brand.brand === 'Google Chrome')
    return {
      browserName: chrome ? 'chrome' : (data.brands.find((brand) => brand.brand !== 'Chromium' && !brand.brand.includes('Not'))?.brand ?? 'unknown').toLowerCase(),
      browserMajor: Number.parseInt(chrome?.version ?? '0', 10) || 0,
      platform: normalizePlatform(data.platform ?? ''),
      mobile: data.mobile === true,
    }
  }

  const agent = navigatorLike.userAgent ?? ''
  // Order matters: Edge's UA contains "Chrome", and Chrome's contains "Safari". Checking the more
  // specific brands first is the only way a UA string yields a useful answer.
  const mobile = /Android|iPhone|iPad|iPod/i.test(agent)
  if (/Edg\//.test(agent)) return { browserName: 'edge', browserMajor: majorFrom(agent, /Edg\/(\d+)/), platform: platformFromAgent(agent), mobile }
  if (/OPR\//.test(agent)) return { browserName: 'opera', browserMajor: majorFrom(agent, /OPR\/(\d+)/), platform: platformFromAgent(agent), mobile }
  if (/Firefox\//.test(agent)) return { browserName: 'firefox', browserMajor: majorFrom(agent, /Firefox\/(\d+)/), platform: platformFromAgent(agent), mobile }
  if (/Chrome\//.test(agent)) return { browserName: 'chrome', browserMajor: majorFrom(agent, /Chrome\/(\d+)/), platform: platformFromAgent(agent), mobile }
  if (/Safari\//.test(agent)) return { browserName: 'safari', browserMajor: majorFrom(agent, /Version\/(\d+)/), platform: platformFromAgent(agent), mobile }
  return { browserName: 'unknown', browserMajor: 0, platform: platformFromAgent(agent), mobile }
}

function majorFrom(agent: string, pattern: RegExp): number {
  return Number.parseInt(pattern.exec(agent)?.[1] ?? '0', 10) || 0
}

function normalizePlatform(value: string): BrowserIdentity['platform'] {
  const lower = value.toLowerCase()
  if (lower.includes('mac')) return 'macos'
  if (lower.includes('win')) return 'windows'
  return 'other'
}

function platformFromAgent(agent: string): BrowserIdentity['platform'] {
  if (/Mac OS X|Macintosh/.test(agent)) return 'macos'
  if (/Windows/.test(agent)) return 'windows'
  return 'other'
}

export interface CaptureSupport {
  /** Whether remote (two-channel) capture is possible at all. */
  remote: boolean
  /** In-person needs only a microphone, so it is supported far more widely. */
  inPerson: boolean
  identity: BrowserIdentity
  /** Why remote is refused, for a sentence the organizer can act on. */
  reason: CaptureError['code'] | null
}

/**
 * Decides what this browser can do, without asking for any permission.
 *
 * Called before the preflight UI renders, so an unsupported browser is told to switch *before* it triggers
 * a permission prompt it cannot use — a prompt a user grants and then discovers was pointless is worse
 * than no prompt.
 */
export function detectCaptureSupport(navigatorLike: {
  userAgent?: string
  userAgentData?: { brands?: UserAgentBrand[]; platform?: string; mobile?: boolean }
  mediaDevices?: { getUserMedia?: unknown; getDisplayMedia?: unknown }
}): CaptureSupport {
  const identity = identifyBrowser(navigatorLike)
  const hasMicrophone = typeof navigatorLike.mediaDevices?.getUserMedia === 'function'
  const hasDisplay = typeof navigatorLike.mediaDevices?.getDisplayMedia === 'function'

  const base = { identity, inPerson: hasMicrophone }
  // Mobile first: Chrome on Android reports the right brand and version and still cannot share a tab's
  // audio at all, so a version check would pass and the capture would then fail with something opaque.
  if (identity.mobile) return { ...base, remote: false, reason: 'unsupported_platform' }
  if (identity.platform === 'other') return { ...base, remote: false, reason: 'unsupported_platform' }
  if (identity.browserName !== 'chrome') return { ...base, remote: false, reason: 'unsupported_browser' }
  if (identity.browserMajor < MINIMUM_SUPPORTED_CHROME_MAJOR) {
    return { ...base, remote: false, reason: 'unsupported_browser' }
  }
  if (!hasMicrophone || !hasDisplay) return { ...base, remote: false, reason: 'unsupported_browser' }

  return { ...base, remote: true, reason: null }
}

/** What `getDisplayMedia` is asked for. Exported so a test reads the real constraints, not a copy. */
export const DISPLAY_MEDIA_CONSTRAINTS = Object.freeze({
  // Required by the spec even though only the audio is wanted. Stopped before the socket opens.
  video: true,
  audio: {
    // The meeting audio must arrive unprocessed: echo cancellation and noise suppression are tuned for a
    // microphone picking up a room, and applying them to a clean remote stream removes speech.
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  // A browser tab, not a window and not a screen. A monitor share captures every notification and every
  // other conversation on the machine.
  preferCurrentTab: false,
  selfBrowserSurface: 'exclude',
  systemAudio: 'exclude',
  monitorTypeSurfaces: 'exclude',
  surfaceSwitching: 'exclude',
  // The organizer keeps hearing the meeting. Without this, sharing the tab mutes it for them.
  audio_playback: 'include',
} as const)

/** What the microphone is asked for, which is the opposite of the meeting stream. */
export const MICROPHONE_CONSTRAINTS = Object.freeze({
  audio: {
    channelCount: 1,
    sampleRate: SAMPLE_RATE,
    // On for the microphone: it is in a room with a speaker playing the meeting back, and without echo
    // cancellation the organizer's channel would carry the candidate's voice too — destroying the very
    // attribution the two-channel design exists for.
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
} as const)

export interface CaptureHandles {
  microphone: MediaStream
  /** Absent for in-person, where there is nothing to share. */
  meeting: MediaStream | null
}

export interface RequestCaptureOptions {
  captureMode: 'in_person' | 'remote_call'
  /**
   * Whether this call is inside a user gesture. `getDisplayMedia` requires transient activation, and a
   * call outside one fails with a `NotAllowedError` indistinguishable from the user clicking "cancel" —
   * which would tell an organizer they denied a prompt they never saw.
   */
  fromUserGesture: boolean
  mediaDevices: {
    getUserMedia: (constraints: unknown) => Promise<MediaStream>
    getDisplayMedia?: (constraints: unknown) => Promise<MediaStream>
  }
  navigatorLike: Parameters<typeof detectCaptureSupport>[0]
}

/**
 * Acquires the streams, and stops the display video track before returning.
 *
 * Everything acquired is released on any failure. A rejected display prompt that left the microphone open
 * leaves a recording indicator lit in the organizer's tab bar during an interview they were told is not
 * being captured.
 */
export async function requestCapture(options: RequestCaptureOptions): Promise<CaptureHandles> {
  const support = detectCaptureSupport(options.navigatorLike)

  if (options.captureMode === 'in_person') {
    if (!support.inPerson) throw new CaptureError('no microphone access in this browser', 'no_microphone', true)
    return { microphone: await getMicrophone(options), meeting: null }
  }

  if (!support.remote) {
    // Manual-only, never microphone-only. A transcript with the candidate's half missing reads as complete
    // and nobody can tell which half is absent.
    throw new CaptureError(
      `remote capture is not supported here (${support.identity.browserName} ${support.identity.browserMajor} on ${support.identity.platform})`,
      support.reason ?? 'unsupported_browser',
      true,
    )
  }
  if (!options.fromUserGesture) {
    throw new CaptureError('screen sharing must be started from a click', 'requires_user_gesture')
  }

  const microphone = await getMicrophone(options)
  let meeting: MediaStream
  try {
    meeting = await options.mediaDevices.getDisplayMedia!(DISPLAY_MEDIA_CONSTRAINTS)
  } catch (error) {
    stopStream(microphone)
    throw asCaptureError(error)
  }

  try {
    assertMeetingTab(meeting)
  } catch (error) {
    stopStream(meeting)
    stopStream(microphone)
    throw error
  }

  // Before returning, and therefore before any caller can connect a socket. A video track alive during a
  // provider connection is a video track something could attach.
  stopVideoTracks(meeting)
  return { microphone, meeting }
}

async function getMicrophone(options: RequestCaptureOptions): Promise<MediaStream> {
  try {
    return await options.mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS)
  } catch (error) {
    throw asCaptureError(error)
  }
}

/**
 * Refuses anything but another tab that is actually producing audio.
 *
 * All three checks are separate because the remedies differ: a monitor share needs "pick the tab", this
 * tab needs "pick the *meeting* tab", and a tab with no audio needs "tick share tab audio" — a checkbox
 * users miss constantly, and the single most common way this setup fails.
 */
export function assertMeetingTab(stream: MediaStream): void {
  const [videoTrack] = stream.getVideoTracks()
  const settings = videoTrack?.getSettings() as { displaySurface?: string } | undefined

  if (settings?.displaySurface !== undefined && settings.displaySurface !== 'browser') {
    throw new CaptureError(
      `expected a browser tab, received a ${settings.displaySurface} share`,
      'not_a_browser_tab',
    )
  }
  // `selfBrowserSurface: 'exclude'` should make this impossible, but the label is the only signal
  // available and a browser that ignored the hint would otherwise feed the transcript back into itself.
  if (videoTrack?.label && /this tab|current tab/i.test(videoTrack.label)) {
    throw new CaptureError('the shared tab is this tab', 'self_tab')
  }
  if (stream.getAudioTracks().length === 0) {
    throw new CaptureError('the shared tab is not sharing its audio', 'no_tab_audio')
  }
}

function asCaptureError(error: unknown): CaptureError {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new CaptureError('permission was refused', 'permission_denied')
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new CaptureError('no microphone was found', 'no_microphone', true)
  }
  return new CaptureError(
    `capture failed: ${typeof name === 'string' ? name : 'unknown'}`,
    'permission_denied',
  )
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

export function stopVideoTracks(stream: MediaStream): void {
  for (const track of stream.getVideoTracks()) {
    track.stop()
    // Removed as well as stopped: a stopped track still on the stream can be read by anything holding a
    // reference to it, and `getVideoTracks().length === 0` is a far easier invariant to assert than
    // "every video track has readyState 'ended'".
    stream.removeTrack(track)
  }
}

/**
 * Interleaves one or two mono channels into 16-bit PCM.
 *
 * Pure and exported, because this is where a channel swap would happen and a swap is invisible in every
 * other test: the audio would still transcribe, and every word would be attributed to the wrong person.
 *
 * Interleaved rather than planar because that is what Deepgram's `multichannel` expects — planar audio
 * would transcribe as two sequential halves of the conversation.
 */
export function interleaveToPcm16(channels: readonly Float32Array[]): Int16Array {
  if (channels.length === 0) return new Int16Array(0)
  const frames = channels[0].length
  const output = new Int16Array(frames * channels.length)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      const sample = channels[channel][frame] ?? 0
      // Clamped before scaling. A sample above 1 would wrap to a large negative value, which is an audible
      // click rather than the clipping a listener expects.
      const clamped = Math.max(-1, Math.min(1, sample))
      // Asymmetric on purpose: Int16 runs -32768..32767, so scaling both directions by 32768 would
      // overflow the positive peak by one.
      output[frame * channels.length + channel] = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff))
    }
  }
  return output
}

export interface MixerNodes {
  context: { close: () => Promise<void> | void; sampleRate: number; state?: string }
  disconnect: () => void
}

export interface AudioMixerOptions {
  captureMode: 'in_person' | 'remote_call'
  handles: CaptureHandles
  /** Called with interleaved PCM, one frame per `FRAME_SAMPLES`. */
  onFrame: (pcm: Int16Array) => void
  /** Injectable so tests can supply a graph without a real `AudioContext`. */
  createContext?: (options: { sampleRate: number }) => AudioContextLike
}

/** The subset of `AudioContext` the mixer uses. Narrow on purpose: a wider type invites reaching for a recorder. */
export interface AudioContextLike {
  sampleRate: number
  state?: string
  createMediaStreamSource: (stream: MediaStream) => AudioNodeLike
  createChannelMerger: (inputs: number) => AudioNodeLike
  createScriptProcessor?: (bufferSize: number, inputs: number, outputs: number) => ScriptProcessorLike
  close: () => Promise<void> | void
  destination: AudioNodeLike
}

export interface AudioNodeLike {
  connect: (destination: AudioNodeLike | ScriptProcessorLike, output?: number, input?: number) => unknown
  disconnect: () => void
}

export interface ScriptProcessorLike extends AudioNodeLike {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null
}

export interface AudioMixer {
  channelCount: 1 | 2
  /** Index → what is on it. Empty for in-person, where one microphone carries two voices. */
  channelLabels: Readonly<Record<number, 'organizer' | 'candidate_or_remote'>>
  stop: () => Promise<void>
}

/**
 * Builds the graph: microphone into channel 0, meeting into channel 1, interleaved out.
 *
 * A remote session whose meeting stream has no audio track does **not** silently become one channel. It
 * throws with `manualOnly`, because a one-channel remote transcript is a transcript of half a conversation
 * presented as a whole.
 */
export async function createAudioMixer(options: AudioMixerOptions): Promise<AudioMixer> {
  const remote = options.captureMode === 'remote_call'
  const meetingAudio = options.handles.meeting?.getAudioTracks() ?? []
  if (remote && meetingAudio.length === 0) {
    throw new CaptureError('the meeting stream carries no audio', 'no_tab_audio', true)
  }

  const channelCount: 1 | 2 = remote ? 2 : 1
  const context = (options.createContext ?? defaultContext)({ sampleRate: SAMPLE_RATE })
  if (!context.createScriptProcessor) {
    throw new CaptureError('this browser cannot process captured audio', 'mixer_unavailable', true)
  }

  const microphoneSource = context.createMediaStreamSource(options.handles.microphone)
  const merger = context.createChannelMerger(channelCount)
  // Channel 0. Not a preference — the label the transcript is attributed by.
  microphoneSource.connect(merger, 0, 0)

  let meetingSource: AudioNodeLike | null = null
  if (remote && options.handles.meeting) {
    meetingSource = context.createMediaStreamSource(options.handles.meeting)
    meetingSource.connect(merger, 0, 1)
  }

  const processor = context.createScriptProcessor(FRAME_SAMPLES, channelCount, channelCount)
  merger.connect(processor)
  processor.onaudioprocess = (event) => {
    const channels: Float32Array[] = []
    for (let channel = 0; channel < channelCount; channel += 1) {
      channels.push(event.inputBuffer.getChannelData(channel))
    }
    options.onFrame(interleaveToPcm16(channels))
  }
  // A ScriptProcessor only runs while connected to a destination. It is connected to the context's own
  // destination, which for the offline-style graph used here produces no output the organizer hears — the
  // meeting playback they hear comes from the browser's own tab audio, not from this graph.
  processor.connect(context.destination)

  return {
    channelCount,
    channelLabels: remote
      ? Object.freeze({ 0: 'organizer' as const, 1: 'candidate_or_remote' as const })
      : Object.freeze({}),
    stop: async () => {
      // Handler first: a frame delivered after the socket closed would be handed to a dead consumer.
      processor.onaudioprocess = null
      processor.disconnect()
      merger.disconnect()
      microphoneSource.disconnect()
      meetingSource?.disconnect()
      stopStream(options.handles.microphone)
      stopStream(options.handles.meeting)
      // Last, and awaited: closing the context while nodes are still attached leaves the microphone
      // indicator lit in some Chrome versions.
      await context.close()
    },
  }
}

function defaultContext(options: { sampleRate: number }): AudioContextLike {
  const Constructor = (globalThis as { AudioContext?: new (options: { sampleRate: number }) => unknown }).AudioContext
  if (!Constructor) throw new CaptureError('Web Audio is unavailable', 'mixer_unavailable', true)
  return new Constructor(options) as unknown as AudioContextLike
}
