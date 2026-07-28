import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CapturePreflight, type ConsentReceipt } from './CapturePreflight'
import { ContextualQuestions, type ContextualSuggestion } from './ContextualQuestions'
import { TranscriptExcerpt, type EvidenceSegment } from './TranscriptEvidence'
import { InterviewControls } from './InterviewControls'
import { InterviewNotes, type InterviewMarker } from './InterviewNotes'
import { LiveTranscript, type TranscriptSegmentView } from './LiveTranscript'
import { SpeakerMapper } from './SpeakerMapper'
import {
  createAudioMixer,
  detectCaptureSupport,
  type AudioMixer,
  type CaptureHandles,
} from '~/modules/interviews/lib/audio-capture'
import {
  DeepgramLiveClient,
  type DeepgramConnectionState,
  type DeepgramGrant,
  type FinalSegment,
} from '~/modules/interviews/lib/deepgram-client'
import {
  openTranscriptOutbox,
  type TranscriptOutbox,
} from '~/modules/interviews/lib/transcript-outbox'

/**
 * The live interview workspace (plan: calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## Every side effect goes through `api`
 *
 * Not because the indirection is elegant — because this component owns a microphone, a screen share, a
 * WebSocket, an IndexedDB store and five endpoints, and a test that had to mock `fetch` globally to reach
 * any of it would end up asserting on mock call counts instead of on what the organizer sees.
 *
 * ## The withdrawal path is the one that must not depend on cooperation
 *
 * Two independent things stop capture. The poll notices `stopNow` and tears the socket down; and the token
 * route refuses the next grant, so a socket that survives the poll cannot outlive its 30-second credential.
 * The first is fast, the second is the guarantee.
 *
 * ## Losing transcription never ends the interview
 *
 * A refused grant, a spent balance, an exhausted reconnect — each drops the page to manual-only and says
 * so. The organizer is mid-conversation with a real person, and a page that ended the session because a
 * socket died would be a worse product than one that keeps taking notes.
 */

export interface LiveInterviewApi {
  createSession: (input: { captureCapability: string; language: 'en' | 'da' }) => Promise<SessionDto>
  markReady: (expectedVersion: number) => Promise<SessionDto>
  goLive: (expectedVersion: number) => Promise<{ session: SessionDto; reservedUnits: number }>
  pause: (expectedVersion: number) => Promise<SessionDto>
  resume: (expectedVersion: number) => Promise<SessionDto>
  finish: (input: { expectedVersion: number; providerBilledSeconds: number; providerRequestId: string | null }) => Promise<SessionDto>
  heartbeat: () => Promise<{ action: 'continue' | 'stop_now' | 'not_live'; session: SessionDto }>
  readSession: () => Promise<{ session: SessionDto | null; stopNow: boolean }>
  mintToken: () => Promise<DeepgramGrant>
  sendSegments: (segments: readonly OutboxShape[]) => Promise<{ accepted: string[]; inserted: number }>
  correctSpeaker: (input: { segmentId: string; speakerMapping: 'organizer' | 'candidate_or_remote' }) => Promise<void>
  saveNotes: (notes: string) => Promise<void>
  /** Absent when contextual questions are switched off for this deployment. */
  suggestFollowups?: () => Promise<{
    source: 'suggested' | 'prepared'
    reason?: string
    suggestions: ContextualSuggestion[]
  }>
  recordSuggestion?: (input: {
    suggestion: ContextualSuggestion
    action: 'used' | 'saved' | 'dismissed'
  }) => Promise<void>
}

interface OutboxShape {
  providerSegmentId: string
  sequence: number
  speakerEstimate: 'speaker_a' | 'speaker_b' | 'unknown'
  text: string
  startsMs: number
  endsMs: number
  confidence: number | null
}

export interface SessionDto {
  id: string
  state: 'not_started' | 'consent_pending' | 'ready' | 'live' | 'paused' | 'processing' | 'review' | 'finalized' | 'failed' | 'abandoned'
  captureMode: 'in_person' | 'remote_call'
  language: 'en' | 'da'
  startedAt: string | null
  version: number
  canControl: boolean
}

export interface LiveInterviewPageProps {
  interviewId: string
  userId: string
  captureMode: 'in_person' | 'remote_call'
  language: 'en' | 'da'
  consent: ConsentReceipt | null
  session: SessionDto | null
  /** Rendered in the sidebar. Absent when no brief was generated, which is not an error. */
  brief: React.ReactNode
  api: LiveInterviewApi
  navigatorLike?: Parameters<typeof detectCaptureSupport>[0]
  /** Injectable for tests; the real page polls every five seconds. */
  pollIntervalMs?: number
  now?: () => number
}

/** Fast enough that a withdrawal is noticed well inside the ten-second deadline. */
export const POLL_INTERVAL_MS = 5_000

export function LiveInterviewPage(props: LiveInterviewPageProps) {
  const clock = props.now ?? Date.now
  const [session, setSession] = useState<SessionDto | null>(props.session)
  const [segments, setSegments] = useState<TranscriptSegmentView[]>([])
  const [interim, setInterim] = useState<string | null>(null)
  const [connection, setConnection] = useState<DeepgramConnectionState | 'manual_only'>('idle')
  const [manualOnlyReason, setManualOnlyReason] = useState<string | null>(null)
  const [withdrawn, setWithdrawn] = useState(false)
  const [reservedUnits, setReservedUnits] = useState<number | null>(null)
  const [markers, setMarkers] = useState<InterviewMarker[]>([])
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [suggestions, setSuggestions] = useState<ContextualSuggestion[]>([])
  const [suggestionSource, setSuggestionSource] = useState<'suggested' | 'prepared' | null>(null)
  const [suggestionReason, setSuggestionReason] = useState<string | null>(null)
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [excerpt, setExcerpt] = useState<EvidenceSegment | null>(null)

  const mixer = useRef<AudioMixer | null>(null)
  const client = useRef<DeepgramLiveClient | null>(null)
  const outbox = useRef<TranscriptOutbox | null>(null)
  const billedSeconds = useRef(0)
  const sequence = useRef(0)

  const support = useMemo(
    () => (props.navigatorLike ? detectCaptureSupport(props.navigatorLike) : null),
    [props.navigatorLike],
  )

  /**
   * Tears down capture without ending the session.
   *
   * Order matters and is the reverse of setup: the socket first so no further frame is sent, then the
   * mixer so the microphone indicator goes out. Reversing it delivers frames to a closed socket.
   */
  const stopCapture = useCallback(async () => {
    client.current?.close()
    client.current = null
    await mixer.current?.stop()
    mixer.current = null
    setInterim(null)
  }, [])

  const dropToManualOnly = useCallback(async (reason: string) => {
    await stopCapture()
    setManualOnlyReason(reason)
    setConnection('manual_only')
  }, [stopCapture])

  /** Drains the outbox, then removes exactly what the server acknowledged. */
  const flushOutbox = useCallback(async () => {
    const store = outbox.current
    if (!store) return
    const pending = await store.pending()
    if (pending.length === 0) return
    // A failure leaves everything in the store on purpose: the next flush, or the next reload, retries —
    // which is the entire reason the outbox exists. Only what the server actually acknowledged is removed,
    // because clearing the store on a partial acceptance would discard segments it never received.
    await props.api.sendSegments(pending)
      .then((result) => store.acknowledge(result.accepted))
      .catch(() => undefined)
  }, [props.api])

  const handleFinal = useCallback((final: FinalSegment) => {
    sequence.current += 1
    const entry: TranscriptSegmentView = {
      id: final.providerSegmentId,
      providerSegmentId: final.providerSegmentId,
      sequence: sequence.current,
      speakerEstimate: final.speakerEstimate,
      speakerMapping: null,
      text: final.text,
      startsMs: final.startsMs,
      endsMs: final.endsMs,
      confidence: final.confidence,
    }
    setSegments((current) => [...current, entry])
    setInterim(null)
    billedSeconds.current = Math.max(billedSeconds.current, Math.ceil(final.endsMs / 1_000))
    // Buffered before it is sent, not after. A send that fails on a segment never written to the outbox is
    // a segment lost with nothing left to retry from.
    void outbox.current?.enqueue([{
      providerSegmentId: entry.providerSegmentId,
      sequence: entry.sequence,
      speakerEstimate: entry.speakerEstimate,
      text: entry.text,
      startsMs: entry.startsMs,
      endsMs: entry.endsMs,
      confidence: entry.confidence,
    }]).then(() => flushOutbox())
  }, [flushOutbox])

  /** Preflight succeeded: build the graph, open the socket, go live. */
  const beginCapture = useCallback(async (handles: CaptureHandles) => {
    setBusy(true)
    setError(null)
    try {
      let current = session ?? await props.api.createSession({
        captureCapability: props.captureMode === 'remote_call'
          ? 'microphone_and_shared_audio_available'
          : 'microphone_only',
        language: props.language,
      })
      if (current.state === 'consent_pending') current = await props.api.markReady(current.version)
      if (current.state === 'ready') {
        const live = await props.api.goLive(current.version)
        current = live.session
        setReservedUnits(live.reservedUnits)
      }
      setSession(current)

      outbox.current = await openTranscriptOutbox({ userId: props.userId, sessionId: current.id })

      const liveClient = new DeepgramLiveClient({
        captureMode: props.captureMode,
        // A function, never a cached grant. The token route re-reads consent on every mint, and that is
        // what makes a withdrawal enforceable against a client that ignores the poll.
        getToken: () => props.api.mintToken(),
        onFinal: handleFinal,
        onStateChange: setConnection,
        onGaveUp: (failure) => {
          setError(readableError(failure))
          void dropToManualOnly('provider_unavailable')
        },
      })
      client.current = liveClient
      await liveClient.connect()

      mixer.current = await createAudioMixer({
        captureMode: props.captureMode,
        handles,
        onFrame: (pcm) => liveClient.enqueue(pcm),
      })
    } catch (thrown) {
      setError(readableError(thrown))
      await dropToManualOnly('start_failed')
    } finally {
      setBusy(false)
    }
  }, [dropToManualOnly, handleFinal, props.api, props.captureMode, props.language, props.userId, session])

  // The withdrawal poll and the heartbeat, on one timer. Two timers would double the request rate for no
  // extra safety, since the beat's answer already carries the withdrawal.
  useEffect(() => {
    if (!session || session.state !== 'live') return
    const interval = props.pollIntervalMs ?? POLL_INTERVAL_MS
    const timer = setInterval(() => {
      void props.api.heartbeat().then(async (beat) => {
        setSession(beat.session)
        if (beat.action === 'stop_now') {
          setWithdrawn(true)
          // Immediately, before the organizer reads anything. The remaining guarantee is the token route
          // refusing the next grant.
          await stopCapture()
          setConnection('closed')
        }
      }).catch(() => undefined)
      void flushOutbox()
    }, interval)
    return () => clearInterval(timer)
  }, [flushOutbox, props.api, props.pollIntervalMs, session, stopCapture])

  // The clock. Derived from `startedAt` rather than counted up, so a backgrounded tab that stopped firing
  // timers does not show a time twenty minutes short of the real one.
  useEffect(() => {
    if (!session?.startedAt || session.state !== 'live') return
    const startedAt = new Date(session.startedAt).getTime()
    const tick = () => setElapsedMs(Math.max(0, clock() - startedAt))
    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [clock, session?.startedAt, session?.state])

  // Teardown on unload as well as unmount. A tab closed mid-interview would otherwise leave the microphone
  // indicator lit until Chrome noticed the page was gone.
  useEffect(() => {
    const release = () => { void stopCapture() }
    globalThis.addEventListener?.('pagehide', release)
    return () => {
      globalThis.removeEventListener?.('pagehide', release)
      release()
    }
  }, [stopCapture])

  const finish = useCallback(async () => {
    if (!session) return
    setBusy(true)
    try {
      await stopCapture()
      // Last chance to send what is buffered, before the session stops accepting segments.
      await flushOutbox()
      const finished = await props.api.finish({
        expectedVersion: session.version,
        providerBilledSeconds: billedSeconds.current,
        providerRequestId: null,
      })
      setSession(finished)
      // The interview is over; anything still unacknowledged will never be accepted now.
      await outbox.current?.clearSession()
    } catch (thrown) {
      setError(readableError(thrown))
    } finally {
      setBusy(false)
    }
  }, [flushOutbox, props.api, session, stopCapture])

  const correctSpeaker = useCallback(async (segmentId: string, mapping: 'organizer' | 'candidate_or_remote') => {
    // Optimistic: the organizer is mid-interview and a round trip before the label changes reads as broken.
    setSegments((current) => current.map((segment) => (
      segment.id === segmentId ? { ...segment, speakerMapping: mapping } : segment
    )))
    await props.api.correctSpeaker({ segmentId, speakerMapping: mapping }).catch(() => {
      setSegments((current) => current.map((segment) => (
        segment.id === segmentId ? { ...segment, speakerMapping: null } : segment
      )))
      setError('That correction did not save. Try again.')
    })
  }, [props.api])

  const mapAll = useCallback((estimate: 'speaker_a' | 'speaker_b', mapping: 'organizer' | 'candidate_or_remote') => {
    for (const segment of segments) {
      if (segment.speakerEstimate === estimate && segment.speakerMapping !== mapping) {
        void correctSpeaker(segment.id, mapping)
      }
    }
  }, [correctSpeaker, segments])

  const askForSuggestions = useCallback(async () => {
    if (!props.api.suggestFollowups) return
    setSuggestBusy(true)
    try {
      const result = await props.api.suggestFollowups()
      setSuggestions(result.suggestions)
      setSuggestionSource(result.source)
      // Held, not rendered as a banner. The panel labels the *source*; the reason is for a test and for a
      // settings page, never for a screen the candidate may be able to see.
      setSuggestionReason(result.reason ?? null)
    } catch {
      // Silent. The organizer is mid-sentence and there is nothing they can do about it now.
      setSuggestionSource('prepared')
    } finally {
      setSuggestBusy(false)
    }
  }, [props.api])

  /** The transcript as evidence, so a citation resolves to a timestamp and a line. */
  const evidenceSegments = useMemo<EvidenceSegment[]>(
    () => segments.map((segment) => ({
      id: segment.id,
      startsMs: segment.startsMs,
      speakerLabel: segment.speakerMapping === 'organizer' ? 'You'
        : segment.speakerMapping === 'candidate_or_remote' ? 'Candidate'
        : segment.speakerEstimate === 'speaker_a' ? 'Speaker A' : 'Speaker B',
      text: segment.text,
    })),
    [segments],
  )

  const capturing = session?.state === 'live' || session?.state === 'paused'
  const remainingCredits = reservedUnits === null
    ? null
    : Math.max(0, reservedUnits - Math.ceil(elapsedMs / 60_000))

  return (
    // `min-w-0` on the grid children and a single column below `md`: at 320 px this is one stacked column,
    // and without `min-w-0` a long transcript line forces the whole page to scroll sideways.
    <div className="grid min-h-0 gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {!capturing && manualOnlyReason === null ? (
          <CapturePreflight
            captureMode={props.captureMode}
            consent={props.consent}
            support={support}
            navigatorLike={props.navigatorLike}
            onReady={(handles) => { void beginCapture(handles) }}
            onManualOnly={(reason) => { void dropToManualOnly(reason) }}
          />
        ) : (
          <InterviewControls
            state={session?.state ?? 'not_started'}
            connection={connection}
            elapsedMs={elapsedMs}
            remainingCredits={remainingCredits}
            withdrawn={withdrawn}
            busy={busy}
            onPause={() => {
              if (!session) return
              setBusy(true)
              void stopCapture()
                .then(() => props.api.pause(session.version))
                .then(setSession)
                .catch((thrown) => setError(readableError(thrown)))
                .finally(() => setBusy(false))
            }}
            onResume={() => {
              if (!session) return
              setBusy(true)
              void props.api.resume(session.version)
                .then(setSession)
                .catch((thrown) => setError(readableError(thrown)))
                .finally(() => setBusy(false))
            }}
            onFinish={() => { void finish() }}
            onReconnect={() => { void client.current?.connect() }}
          />
        )}

        <LiveTranscript
          captureMode={props.captureMode}
          segments={segments}
          interim={interim}
          paused={session?.state === 'paused'}
          manualOnlyReason={manualOnlyReason}
          onCorrectSpeaker={(id, mapping) => { void correctSpeaker(id, mapping) }}
          now={clock}
        />

        <SpeakerMapper
          captureMode={props.captureMode}
          segments={segments}
          onMapAll={mapAll}
          disabled={busy}
        />

        <TranscriptExcerpt segment={excerpt} onClose={() => setExcerpt(null)} />
      </div>

      <aside className="flex min-w-0 flex-col gap-6">
        <InterviewNotes
          notes={notes}
          markers={markers}
          elapsedMs={elapsedMs}
          onSaveNotes={async (value) => {
            setNotes(value)
            await props.api.saveNotes(value)
          }}
          onAddMarker={(atMs) => setMarkers((current) => [
            ...current,
            { id: `marker-${current.length + 1}`, atMs, label: 'Come back to this' },
          ])}
        />
        {props.api.suggestFollowups && (
          <ContextualQuestions
            suggestions={suggestions}
            source={suggestionSource}
            reason={suggestionReason}
            segments={evidenceSegments}
            busy={suggestBusy}
            // Offered only while live: a suggestion about what was just said is meaningless when nothing is
            // being said, and the server refuses it anyway.
            onAsk={session?.state === 'live' ? () => { void askForSuggestions() } : undefined}
            onAction={(suggestion, action) => { void props.api.recordSuggestion?.({ suggestion, action }) }}
            onOpenSegment={setExcerpt}
          />
        )}

        {props.brief}
      </aside>
    </div>
  )
}

/**
 * The sentence to show for a failure.
 *
 * The error *code* only. A server message can echo request details, and this page's requests carry a
 * candidate's transcript.
 */
export function readableError(thrown: unknown): string {
  const failure = thrown as { code?: unknown; reason?: unknown } | null
  // `reason` first. A `DeepgramClientError` wraps whatever refused the grant, and its own `code` is
  // `no_token` for a withdrawal, a spent balance and a network fault alike — three situations with three
  // different things the organizer needs to do.
  const code = typeof failure?.reason === 'string' ? failure.reason : failure?.code
  switch (code) {
    case 'insufficient_credits':
      return 'Not enough credits to transcribe. The interview can continue with notes only.'
    case 'not_entitled':
      return 'This plan does not include live transcription.'
    case 'consent_withdrawn':
      return 'The candidate withdrew consent, so transcription has stopped.'
    case 'consent_missing':
      return 'There is no consent on file for transcribing this interview.'
    case 'version_conflict':
      return 'This interview changed in another tab. Reload to catch up.'
    case 'gave_up':
    case 'no_token':
      return 'Transcription stopped and could not restart. Your notes are still saved.'
    default:
      return 'Something went wrong. Your notes are still saved.'
  }
}
