import { createFileRoute, useParams } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LiveInterviewPage,
  type LiveInterviewApi,
  type SessionDto,
} from '~/modules/interviews/components/LiveInterviewPage'
import type { ConsentReceipt } from '~/modules/interviews/components/CapturePreflight'

/**
 * The live interview workspace route (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## A separate page from the brief, not a tab on it
 *
 * A live interview holds a microphone, a screen share and a socket. Mounting that inside the preparation
 * page would mean a navigation away from the transcript tore capture down mid-conversation, and a route is
 * the only boundary that makes "leaving this page ends capture" a thing the user can see coming.
 *
 * ## This file is the HTTP layer and nothing else
 *
 * Every request lives in the `api` object built here; the page itself takes it as a prop. That is what lets
 * the workspace be tested without a server, and it keeps the error mapping — which must never forward a
 * server message that could echo transcript content — in one readable place.
 */
export const Route = createFileRoute('/_dashboard/interviews/$interviewId/live')({
  component: LiveInterviewRoute,
})

/** An error carrying the server's code, which is the only part of a failure this app shows a user. */
class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'ApiError'
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    // Same-origin only. The endpoints check the origin themselves; this makes the browser agree.
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    // The code, never a message. A server message can echo request details, and these requests carry a
    // candidate's transcript.
    throw new ApiError(body.error ?? 'failed', response.status)
  }
  return response.json() as Promise<T>
}

function LiveInterviewRoute() {
  const { interviewId } = useParams({ from: '/_dashboard/interviews/$interviewId/live' })
  const [bootstrap, setBootstrap] = useState<{
    session: SessionDto | null
    consent: ConsentReceipt | null
    captureMode: 'in_person' | 'remote_call'
    language: 'en' | 'da'
    userId: string
  } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await call<{
        session: SessionDto | null
        consent: ConsentReceipt | null
        captureMode: 'in_person' | 'remote_call'
        language: 'en' | 'da'
        userId: string
      }>(`/api/interviews/${interviewId}/session`)
      setBootstrap(result)
    } catch (thrown) {
      setLoadError(thrown instanceof ApiError && thrown.status === 403
        ? 'You do not have access to this interview.'
        : 'This interview could not be loaded.')
    }
  }, [interviewId])

  useEffect(() => { void load() }, [load])

  const api = useMemo<LiveInterviewApi>(() => {
    const base = `/api/interviews/${interviewId}`
    const post = <T,>(body: unknown) => call<T>(`${base}/session`, { method: 'POST', body: JSON.stringify(body) })
    return {
      createSession: (input) => post<{ session: SessionDto }>({ action: 'create', ...input }).then((r) => r.session),
      markReady: (expectedVersion) => post<{ session: SessionDto }>({ action: 'ready', expectedVersion }).then((r) => r.session),
      goLive: (expectedVersion) => post<{ session: SessionDto; reservedUnits: number }>({ action: 'live', expectedVersion }),
      pause: (expectedVersion) => post<{ session: SessionDto }>({ action: 'pause', expectedVersion }).then((r) => r.session),
      resume: (expectedVersion) => post<{ session: SessionDto }>({ action: 'resume', expectedVersion }).then((r) => r.session),
      finish: (input) => post<{ session: SessionDto }>({ action: 'finish', ...input }).then((r) => r.session),
      // No `expectedVersion`: a beat transitions nothing, and requiring one would stop a client whose
      // version had drifted from keeping its own session out of reclaim.
      heartbeat: () => post<{ action: 'continue' | 'stop_now' | 'not_live'; session: SessionDto }>({ action: 'heartbeat' }),
      readSession: () => call<{ session: SessionDto | null; stopNow: boolean }>(`${base}/session`),
      mintToken: () => call(`${base}/transcription-token`, { method: 'POST' }),
      sendSegments: (segments) => call(`${base}/segments`, { method: 'POST', body: JSON.stringify({ segments }) }),
      correctSpeaker: (input) => call<void>(`${base}/segments`, { method: 'PATCH', body: JSON.stringify(input) }),
      // Notes live on the session's own row in a later phase; for now they are held in the page and this
      // resolves so the autosave indicator tells the truth about what it did.
      saveNotes: async () => undefined,
    }
  }, [interviewId])

  if (loadError) {
    return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{loadError}</p>
  }
  if (!bootstrap) return <p className="text-sm text-muted-foreground">Loading the interview…</p>

  return (
    <LiveInterviewPage
      interviewId={interviewId}
      userId={bootstrap.userId}
      captureMode={bootstrap.captureMode}
      language={bootstrap.language}
      consent={bootstrap.consent}
      session={bootstrap.session}
      brief={null}
      api={api}
      navigatorLike={typeof navigator === 'undefined' ? undefined : navigator}
    />
  )
}
