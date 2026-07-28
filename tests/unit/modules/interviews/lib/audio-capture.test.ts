/**
 * Mocked media, real graph assertions, and a static check on what the source is *allowed to contain*.
 *
 * `getDisplayMedia` cannot be exercised for real in a test — it needs a user picking a tab — so the
 * constraints, the ordering and the refusals are what get asserted. The one thing a behavioural test can
 * never cover is a future refactor introducing `MediaRecorder`, so that is checked by reading the file.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  assertMeetingTab,
  CaptureError,
  createAudioMixer,
  detectCaptureSupport,
  DISPLAY_MEDIA_CONSTRAINTS,
  FRAME_SAMPLES,
  identifyBrowser,
  interleaveToPcm16,
  MICROPHONE_CONSTRAINTS,
  MINIMUM_SUPPORTED_CHROME_MAJOR,
  requestCapture,
  SAMPLE_RATE,
  stopVideoTracks,
  type AudioContextLike,
  type AudioNodeLike,
  type ScriptProcessorLike,
} from '~/modules/interviews/lib/audio-capture'

const CURRENT = MINIMUM_SUPPORTED_CHROME_MAJOR + 1

function track(kind: 'audio' | 'video', overrides: Record<string, unknown> = {}) {
  return {
    kind,
    label: kind === 'video' ? 'Meet — Interview' : 'microphone',
    readyState: 'live',
    stop: vi.fn(function stop(this: { readyState: string }) { this.readyState = 'ended' }),
    getSettings: () => ({ displaySurface: 'browser' }),
    ...overrides,
  }
}

function stream(tracks: Array<ReturnType<typeof track>>): MediaStream {
  const list = [...tracks]
  return {
    getTracks: () => list,
    getAudioTracks: () => list.filter((entry) => entry.kind === 'audio'),
    getVideoTracks: () => list.filter((entry) => entry.kind === 'video'),
    removeTrack: (target: unknown) => {
      const at = list.indexOf(target as ReturnType<typeof track>)
      if (at >= 0) list.splice(at, 1)
    },
  } as unknown as MediaStream
}

const chromeNavigator = (overrides: Record<string, unknown> = {}) => ({
  userAgentData: {
    brands: [
      { brand: 'Not(A:Brand', version: '99' },
      { brand: 'Chromium', version: String(CURRENT) },
      { brand: 'Google Chrome', version: String(CURRENT) },
    ],
    platform: 'macOS',
    mobile: false,
  },
  mediaDevices: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() },
  ...overrides,
})

describe('browser identification', () => {
  it('reads the brand from userAgentData rather than trusting a UA string', () => {
    const identity = identifyBrowser(chromeNavigator())
    expect(identity).toEqual({ browserName: 'chrome', browserMajor: CURRENT, platform: 'macos', mobile: false })
  })

  it('does not mistake Edge for Chrome', () => {
    // Edge's UA contains "Chrome", and its display-capture behaviour is not what this feature verified.
    const identity = identifyBrowser({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    })
    expect(identity.browserName).toBe('edge')
    expect(identity.platform).toBe('windows')
  })

  it('does not mistake Chrome for Safari', () => {
    // Chrome's UA contains "Safari". Order of the checks is the only thing that makes this right.
    const identity = identifyBrowser({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    })
    expect(identity.browserName).toBe('chrome')
  })

  it('identifies Safari, Firefox and Opera by name', () => {
    expect(identifyBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' }).browserName).toBe('safari')
    expect(identifyBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0' }).browserName).toBe('firefox')
    expect(identifyBrowser({ userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 OPR/115.0.0.0' }).browserName).toBe('opera')
  })

  it('notices a mobile browser even when it reports Chrome', () => {
    const identity = identifyBrowser({ userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36' })
    expect(identity.mobile).toBe(true)
  })
})

describe('the browser and platform matrix for remote capture', () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['current Chrome on macOS', {}, true],
    ['previous Chrome on macOS', { userAgentData: { brands: [{ brand: 'Google Chrome', version: String(MINIMUM_SUPPORTED_CHROME_MAJOR) }], platform: 'macOS', mobile: false } }, true],
    ['Chrome on Windows', { userAgentData: { brands: [{ brand: 'Google Chrome', version: String(CURRENT) }], platform: 'Windows', mobile: false } }, true],
    ['too old a Chrome', { userAgentData: { brands: [{ brand: 'Google Chrome', version: String(MINIMUM_SUPPORTED_CHROME_MAJOR - 1) }], platform: 'macOS', mobile: false } }, false],
    ['Chrome on Linux', { userAgentData: { brands: [{ brand: 'Google Chrome', version: String(CURRENT) }], platform: 'Linux', mobile: false } }, false],
    ['Chrome on Android', { userAgentData: { brands: [{ brand: 'Google Chrome', version: String(CURRENT) }], platform: 'Android', mobile: true } }, false],
    ['Edge', { userAgentData: { brands: [{ brand: 'Microsoft Edge', version: String(CURRENT) }], platform: 'Windows', mobile: false } }, false],
    ['Safari', { userAgentData: undefined, userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' }, false],
  ]

  it.each(cases)('remote on %s → %s', (_label, overrides, expected) => {
    expect(detectCaptureSupport(chromeNavigator(overrides)).remote).toBe(expected)
  })

  it('still allows in-person wherever a microphone exists', () => {
    // Safari cannot share a tab's audio and can absolutely record a microphone in a room. Refusing
    // in-person too would remove the feature from a browser that supports it perfectly.
    const support = detectCaptureSupport(chromeNavigator({
      userAgentData: undefined,
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    }))
    expect(support.remote).toBe(false)
    expect(support.inPerson).toBe(true)
  })

  it('refuses remote when getDisplayMedia is missing entirely', () => {
    const support = detectCaptureSupport(chromeNavigator({ mediaDevices: { getUserMedia: vi.fn() } }))
    expect(support.remote).toBe(false)
    expect(support.reason).toBe('unsupported_browser')
  })

  it('names a platform problem separately from a browser problem', () => {
    // The remedies differ: one is "use Chrome", the other is "use a desktop".
    expect(detectCaptureSupport(chromeNavigator({
      userAgentData: { brands: [{ brand: 'Google Chrome', version: String(CURRENT) }], platform: 'Linux', mobile: false },
    })).reason).toBe('unsupported_platform')
    expect(detectCaptureSupport(chromeNavigator({
      userAgentData: { brands: [{ brand: 'Microsoft Edge', version: String(CURRENT) }], platform: 'macOS', mobile: false },
    })).reason).toBe('unsupported_browser')
  })
})

describe('the display constraints', () => {
  it('excludes this tab, the system audio and every monitor surface', () => {
    expect(DISPLAY_MEDIA_CONSTRAINTS.selfBrowserSurface).toBe('exclude')
    expect(DISPLAY_MEDIA_CONSTRAINTS.systemAudio).toBe('exclude')
    expect(DISPLAY_MEDIA_CONSTRAINTS.monitorTypeSurfaces).toBe('exclude')
    expect(DISPLAY_MEDIA_CONSTRAINTS.preferCurrentTab).toBe(false)
  })

  it('keeps the meeting audible to the organizer', () => {
    // Without this, sharing the tab mutes it for the person conducting the interview.
    expect(DISPLAY_MEDIA_CONSTRAINTS.audio_playback).toBe('include')
  })

  it('leaves the meeting audio unprocessed and the microphone processed', () => {
    // Opposite on purpose. Echo cancellation on a clean remote stream removes speech; off on a microphone
    // in a room with a speaker would put the candidate's voice into the organizer's channel and destroy
    // the attribution the whole two-channel design exists for.
    expect(DISPLAY_MEDIA_CONSTRAINTS.audio.echoCancellation).toBe(false)
    expect(MICROPHONE_CONSTRAINTS.audio.echoCancellation).toBe(true)
    expect(MICROPHONE_CONSTRAINTS.video).toBe(false)
  })
})

describe('requesting capture', () => {
  function devices(displayStream: MediaStream | Error = stream([track('video'), track('audio')])) {
    return {
      getUserMedia: vi.fn(async () => stream([track('audio')])),
      getDisplayMedia: vi.fn(async () => {
        if (displayStream instanceof Error) throw displayStream
        return displayStream
      }),
    }
  }

  const request = (overrides: Record<string, unknown> = {}) => requestCapture({
    captureMode: 'remote_call',
    fromUserGesture: true,
    mediaDevices: devices(),
    navigatorLike: chromeNavigator(),
    ...overrides,
  } as Parameters<typeof requestCapture>[0])

  it('requires a user gesture for the display prompt', async () => {
    await expect(request({ fromUserGesture: false })).rejects.toMatchObject({ code: 'requires_user_gesture' })
  })

  it('does not ask for the microphone before it knows a gesture happened', async () => {
    const mediaDevices = devices()
    await expect(request({ fromUserGesture: false, mediaDevices })).rejects.toThrow(CaptureError)
    // A prompt the user cannot complete is a prompt that should not have been shown.
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled()
  })

  it('stops the video track before returning', async () => {
    const video = track('video')
    const handles = await request({ mediaDevices: devices(stream([video, track('audio')])) })
    // Before returning, so before any caller can open a socket. A video track alive during a provider
    // connection is one something could attach.
    expect(video.stop).toHaveBeenCalled()
    expect(handles.meeting!.getVideoTracks()).toHaveLength(0)
    expect(handles.meeting!.getAudioTracks()).toHaveLength(1)
  })

  it('releases the microphone when the display prompt is refused', async () => {
    const microphone = track('audio')
    const mediaDevices = {
      getUserMedia: vi.fn(async () => stream([microphone])),
      getDisplayMedia: vi.fn(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }) }),
    }
    await expect(request({ mediaDevices })).rejects.toMatchObject({ code: 'permission_denied' })
    // Otherwise a recording indicator stays lit in the tab bar of an interview nobody is capturing.
    expect(microphone.stop).toHaveBeenCalled()
  })

  it('releases both streams when the share is the wrong surface', async () => {
    const microphone = track('audio')
    const video = track('video', { getSettings: () => ({ displaySurface: 'monitor' }) })
    const meetingAudio = track('audio')
    const mediaDevices = {
      getUserMedia: vi.fn(async () => stream([microphone])),
      getDisplayMedia: vi.fn(async () => stream([video, meetingAudio])),
    }
    await expect(request({ mediaDevices })).rejects.toMatchObject({ code: 'not_a_browser_tab' })
    expect(microphone.stop).toHaveBeenCalled()
    expect(video.stop).toHaveBeenCalled()
    expect(meetingAudio.stop).toHaveBeenCalled()
  })

  it('degrades an unsupported browser to manual-only, never microphone-only', async () => {
    const error = await request({
      navigatorLike: chromeNavigator({
        userAgentData: { brands: [{ brand: 'Microsoft Edge', version: String(CURRENT) }], platform: 'Windows', mobile: false },
      }),
    }).catch((thrown: CaptureError) => thrown)
    expect(error).toBeInstanceOf(CaptureError)
    // A transcript with the candidate's half missing reads as complete and nobody can tell which half is
    // absent. Manual-only is honest; microphone-only remote is not.
    expect((error as CaptureError).manualOnly).toBe(true)
  })

  it('never calls getDisplayMedia for an in-person interview', async () => {
    const mediaDevices = devices()
    const handles = await requestCapture({
      captureMode: 'in_person', fromUserGesture: true, mediaDevices,
      navigatorLike: chromeNavigator(),
    } as Parameters<typeof requestCapture>[0])
    expect(mediaDevices.getDisplayMedia).not.toHaveBeenCalled()
    expect(handles.meeting).toBeNull()
  })
})

describe('the meeting-tab checks', () => {
  it('refuses a window share', () => {
    expect(() => assertMeetingTab(stream([
      track('video', { getSettings: () => ({ displaySurface: 'window' }) }), track('audio'),
    ]))).toThrow(expect.objectContaining({ code: 'not_a_browser_tab' }))
  })

  it('refuses this tab', () => {
    expect(() => assertMeetingTab(stream([
      track('video', { label: 'This tab — BuilderHunt' }), track('audio'),
    ]))).toThrow(expect.objectContaining({ code: 'self_tab' }))
  })

  it('refuses a tab that shared no audio', () => {
    // The checkbox users miss constantly, and the single most common way this setup fails.
    expect(() => assertMeetingTab(stream([track('video')])))
      .toThrow(expect.objectContaining({ code: 'no_tab_audio' }))
  })

  it('accepts a tab share with audio', () => {
    expect(() => assertMeetingTab(stream([track('video'), track('audio')]))).not.toThrow()
  })

  it('accepts a browser that reports no displaySurface at all', () => {
    // Refusing on an absent setting would break capture on a browser that simply does not report it,
    // while the other two checks still apply.
    expect(() => assertMeetingTab(stream([
      track('video', { getSettings: () => ({}) }), track('audio'),
    ]))).not.toThrow()
  })
})

describe('PCM conversion', () => {
  it('interleaves two channels rather than concatenating them', () => {
    const left = new Float32Array([1, 1, 1])
    const right = new Float32Array([-1, -1, -1])
    const pcm = interleaveToPcm16([left, right])
    // Planar audio would transcribe as two sequential halves of the conversation.
    expect(pcm.length).toBe(6)
    expect([...pcm]).toEqual([32767, -32768, 32767, -32768, 32767, -32768])
  })

  it('keeps channel 0 first, which is what attributes the transcript', () => {
    // A swap here is invisible everywhere else: the audio still transcribes, and every word is attributed
    // to the wrong person.
    const pcm = interleaveToPcm16([new Float32Array([0.5]), new Float32Array([-0.5])])
    expect(pcm[0]).toBeGreaterThan(0)
    expect(pcm[1]).toBeLessThan(0)
  })

  it('clamps rather than wrapping', () => {
    // A sample above 1 scaled without clamping wraps to a large negative value — an audible click, not the
    // clipping a listener expects.
    const pcm = interleaveToPcm16([new Float32Array([2, -2])])
    expect([...pcm]).toEqual([32767, -32768])
  })

  it('does not overflow the positive peak', () => {
    // Int16 runs -32768..32767. Scaling both directions by 32768 would push 1.0 to -32768.
    expect(interleaveToPcm16([new Float32Array([1])])[0]).toBe(32767)
  })

  it('handles a single channel for in-person', () => {
    expect(interleaveToPcm16([new Float32Array([0, 0.5])]).length).toBe(2)
  })

  it('returns nothing for no channels', () => {
    expect(interleaveToPcm16([]).length).toBe(0)
  })
})

describe('the mixer graph', () => {
  function fakeContext() {
    const connections: Array<{ from: string; output?: number; input?: number }> = []
    const disconnects: string[] = []
    let processor: ScriptProcessorLike | null = null
    const node = (name: string): AudioNodeLike => ({
      connect: (_destination, output, input) => { connections.push({ from: name, output, input }); return undefined },
      disconnect: () => { disconnects.push(name) },
    })
    const sources: string[] = []
    const context: AudioContextLike & { closed: boolean } = {
      sampleRate: SAMPLE_RATE,
      closed: false,
      destination: node('destination'),
      createMediaStreamSource: () => {
        const name = `source-${sources.length}`
        sources.push(name)
        return node(name)
      },
      createChannelMerger: vi.fn(() => node('merger')),
      createScriptProcessor: vi.fn((bufferSize: number, inputs: number) => {
        processor = { ...node(`processor-${bufferSize}-${inputs}`), onaudioprocess: null } as ScriptProcessorLike
        return processor
      }),
      close: async () => { context.closed = true },
    }
    return { context, connections, disconnects, getProcessor: () => processor }
  }

  const handles = (withMeeting: boolean) => ({
    microphone: stream([track('audio')]),
    meeting: withMeeting ? stream([track('audio')]) : null,
  })

  it('puts the microphone on channel 0 and the meeting on channel 1', async () => {
    const harness = fakeContext()
    await createAudioMixer({
      captureMode: 'remote_call', handles: handles(true), onFrame: () => undefined,
      createContext: () => harness.context,
    })
    const toMerger = harness.connections.filter((entry) => entry.from.startsWith('source-'))
    // Deterministic, because we put them there. This is why remote uses multichannel and not diarization.
    expect(toMerger).toEqual([
      { from: 'source-0', output: 0, input: 0 },
      { from: 'source-1', output: 0, input: 1 },
    ])
  })

  it('reports two channels and both labels for remote', async () => {
    const harness = fakeContext()
    const mixer = await createAudioMixer({
      captureMode: 'remote_call', handles: handles(true), onFrame: () => undefined,
      createContext: () => harness.context,
    })
    expect(mixer.channelCount).toBe(2)
    expect(mixer.channelLabels).toEqual({ 0: 'organizer', 1: 'candidate_or_remote' })
  })

  it('reports one channel and no labels for in-person', async () => {
    const harness = fakeContext()
    const mixer = await createAudioMixer({
      captureMode: 'in_person', handles: handles(false), onFrame: () => undefined,
      createContext: () => harness.context,
    })
    expect(mixer.channelCount).toBe(1)
    // No labels: one microphone carrying two voices makes attribution impossible, which is exactly why
    // diarization and `speaker_mapping` exist.
    expect(mixer.channelLabels).toEqual({})
  })

  it('refuses a remote session whose meeting stream has no audio', async () => {
    const harness = fakeContext()
    const error = await createAudioMixer({
      captureMode: 'remote_call',
      handles: { microphone: stream([track('audio')]), meeting: stream([]) },
      onFrame: () => undefined,
      createContext: () => harness.context,
    }).catch((thrown: CaptureError) => thrown)
    expect((error as CaptureError).code).toBe('no_tab_audio')
    // Not a silent fall back to one channel: that produces half a conversation presented as a whole.
    expect((error as CaptureError).manualOnly).toBe(true)
  })

  it('uses the 20 ms frame size', async () => {
    const harness = fakeContext()
    await createAudioMixer({
      captureMode: 'remote_call', handles: handles(true), onFrame: () => undefined,
      createContext: () => harness.context,
    })
    expect(harness.context.createScriptProcessor).toHaveBeenCalledWith(FRAME_SAMPLES, 2, 2)
  })

  it('delivers interleaved PCM to onFrame', async () => {
    const harness = fakeContext()
    const frames: Int16Array[] = []
    await createAudioMixer({
      captureMode: 'remote_call', handles: handles(true), onFrame: (pcm) => frames.push(pcm),
      createContext: () => harness.context,
    })
    harness.getProcessor()!.onaudioprocess!({
      inputBuffer: {
        getChannelData: (channel: number) => new Float32Array(channel === 0 ? [1, 1] : [-1, -1]),
      },
    })
    expect([...frames[0]]).toEqual([32767, -32768, 32767, -32768])
  })

  it('tears everything down and stops the handler first', async () => {
    const harness = fakeContext()
    const microphone = track('audio')
    const meeting = track('audio')
    const mixer = await createAudioMixer({
      captureMode: 'remote_call',
      handles: { microphone: stream([microphone]), meeting: stream([meeting]) },
      onFrame: () => { throw new Error('a frame arrived after stop') },
      createContext: () => harness.context,
    })
    await mixer.stop()

    // Nulled before disconnecting, so a frame in flight is not handed to a dead consumer.
    expect(harness.getProcessor()!.onaudioprocess).toBeNull()
    expect(harness.disconnects).toEqual(expect.arrayContaining(['merger', 'source-0', 'source-1']))
    expect(microphone.stop).toHaveBeenCalled()
    expect(meeting.stop).toHaveBeenCalled()
    // Closed last and awaited: closing while nodes are attached leaves the microphone indicator lit in
    // some Chrome versions.
    expect(harness.context.closed).toBe(true)
  })

  it('refuses a browser with no script processor', async () => {
    const harness = fakeContext()
    const context = { ...harness.context, createScriptProcessor: undefined }
    await expect(createAudioMixer({
      captureMode: 'in_person', handles: handles(false), onFrame: () => undefined,
      createContext: () => context as AudioContextLike,
    })).rejects.toMatchObject({ code: 'mixer_unavailable', manualOnly: true })
  })
})

describe('stopVideoTracks', () => {
  it('stops and removes, not just stops', async () => {
    const video = track('video')
    const media = stream([video, track('audio')])
    stopVideoTracks(media)
    expect(video.stop).toHaveBeenCalled()
    // Removed as well: `getVideoTracks().length === 0` is a far easier invariant to hold than "every video
    // track has readyState 'ended'", and a stopped track still on the stream can be read by anything
    // holding a reference.
    expect(media.getVideoTracks()).toHaveLength(0)
    expect(media.getAudioTracks()).toHaveLength(1)
  })
})

describe('nothing in this module can record', () => {
  const sources = [
    'src/modules/interviews/lib/audio-capture.ts',
    'src/modules/interviews/lib/deepgram-client.ts',
  ]

  /**
   * Read from disk rather than inspected at runtime.
   *
   * A behavioural test cannot cover a refactor that introduces a recorder — the new code path would simply
   * not be exercised. This is the only check that survives someone adding "just a debug download button".
   */
  const forbidden: Array<[string, RegExp]> = [
    ['MediaRecorder', /\bMediaRecorder\b/],
    ['a Blob constructor', /new\s+Blob\b/],
    ['createObjectURL', /createObjectURL/],
    ['an audio element', /createElement\(\s*['"]audio['"]/],
    ['a video element', /createElement\(\s*['"]video['"]/],
    ['srcObject', /\bsrcObject\b/],
    ['captureStream', /\bcaptureStream\b/],
    ['a download anchor', /\bdownload\s*=/],
    ['FileSystem access', /showSaveFilePicker/],
  ]

  it.each(sources)('%s contains no recording path', async (relative) => {
    const source = await readFile(join(process.cwd(), relative), 'utf8')
    for (const [label, pattern] of forbidden) {
      // The comments in these files describe what is absent, so a naive match would hit its own
      // documentation. Comment lines are stripped before the check.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
      expect(code, `${relative} must not reference ${label}`).not.toMatch(pattern)
    }
  })

  it('the check would notice a recorder', async () => {
    // Proving the assertion above can fail. Without this, a broken regex would report clean forever.
    const planted = 'const recorder = new MediaRecorder(stream)'
    expect(planted).toMatch(/\bMediaRecorder\b/)
    expect('const url = URL.createObjectURL(blob)').toMatch(/createObjectURL/)
  })

  it('requests no video from the microphone and only a throwaway one from the display', () => {
    expect(MICROPHONE_CONSTRAINTS.video).toBe(false)
    // `true` and not a resolution: the track is stopped before the socket opens, so asking for a size
    // would allocate an encoder for frames nobody reads.
    expect(DISPLAY_MEDIA_CONSTRAINTS.video).toBe(true)
  })
})
