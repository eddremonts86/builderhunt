// In-process metrics. Resets on server restart. Cheap and effective for
// bootstrap scale. Swap for a real metrics system when volume justifies.

interface Counters {
  searches: number
  searchCacheHits: number
  /** A search connector stopped being waited on after `CONNECTOR_TIMEOUT_MS` (`lib/search.ts`). One
   * source timing out no longer fails the search, so this counter is the only signal that it did —
   * a rising value means a third-party API is degrading while results still look fine. */
  searchConnectorTimeouts: number
  /** A search connector threw or returned an unusable shape. Same rationale: isolation means the
   * user sees partial results rather than an error, so the outage is invisible without this. */
  searchConnectorFailures: number
  apiRequests: number
  apiErrors: number
  signups: number
  signins: number
  /** Checkout attempts rejected for `country_not_allowed` (`billing/checkout.ts`, `billing/packs.ts`) — the only trace of a country-gate rejection, since it happens before any `billing_checkout_attempts` row is ever written. */
  checkoutCountryGateRejections: number
  /** `checkAndConsumeBudget` (`ai/budget.ts`) denials with `reason: 'budget'` — a tier that ran out of its daily allowance, not one with a zero allowance (`reason: 'plan'`, not counted here). */
  aiBudgetDenials: number

  // ── Interviews (plan: calendar-scheduling-interview-intelligence, Phase 11) ──────────────────────
  //
  // Counters and IDs only, never content. Every one of these is a number a dashboard can show without a
  // candidate's name, a document, or a line of transcript existing anywhere near it — which is why they are
  // counters rather than a sampled log of what happened.

  /** A candidate picked a slot that was taken between the preview and the booking. Rising means the preview window is too wide. */
  interviewBookingConflicts: number
  /** Documents waiting to be scanned or extracted. A backlog that does not drain means the worker is not being called. */
  interviewDocumentBacklog: number
  /** Documents that ended `failed` or `rejected`. Distinct from the backlog: these will never drain. */
  interviewDocumentFailures: number
  /** Capture sessions by what the browser could actually do. `audio_capture_unsupported` rising is a support signal, not an error. */
  interviewCaptureRemote: number
  interviewCaptureInPerson: number
  interviewCaptureUnsupported: number
  /** Provider socket reconnects. One per interview is normal; a cluster is a network or provider problem. */
  interviewTranscriptReconnects: number
  /** Final segments the server accepted. With `interviewSegmentRetries`, this is the outbox's real delivery rate. */
  interviewSegmentsPersisted: number
  /** Segments re-sent because the first attempt was not acknowledged. */
  interviewSegmentRetries: number
  /** Provider errors by side: a 5xx is theirs, a schema failure is the model's, a refused grant is ours. */
  interviewProviderErrors: number
  interviewAiParseFailures: number
  /** AI calls that fell back to the deterministic template. The honest measure of how often the feature is not usable. */
  interviewTemplateFallbacks: number
  /** Output refused for prohibited content. Any non-zero value is worth reading — see the post-market monitoring doc. */
  interviewProhibitedOutputRefusals: number
  /** Reservations released because a session went stale rather than finishing. */
  interviewStaleReservations: number
  /** Settlements whose provider figure differed beyond policy. */
  interviewUsageVariances: number
  /** Rows and objects the retention sweep removed. */
  interviewRetentionRowsDeleted: number
  interviewRetentionObjectsDeleted: number
  /** Object deletions the sweep could not perform. A row is kept for each, so this must return to zero. */
  interviewRetentionObjectFailures: number
  /** Interviews whose scheduled end has passed with no session ever started. A stale-schedule signal. */
  interviewSchedulesStale: number
}

const counters: Counters = {
  searches: 0,
  searchCacheHits: 0,
  searchConnectorTimeouts: 0,
  searchConnectorFailures: 0,
  apiRequests: 0,
  apiErrors: 0,
  signups: 0,
  signins: 0,
  checkoutCountryGateRejections: 0,
  aiBudgetDenials: 0,
  interviewBookingConflicts: 0,
  interviewDocumentBacklog: 0,
  interviewDocumentFailures: 0,
  interviewCaptureRemote: 0,
  interviewCaptureInPerson: 0,
  interviewCaptureUnsupported: 0,
  interviewTranscriptReconnects: 0,
  interviewSegmentsPersisted: 0,
  interviewSegmentRetries: 0,
  interviewProviderErrors: 0,
  interviewAiParseFailures: 0,
  interviewTemplateFallbacks: 0,
  interviewProhibitedOutputRefusals: 0,
  interviewStaleReservations: 0,
  interviewUsageVariances: 0,
  interviewRetentionRowsDeleted: 0,
  interviewRetentionObjectsDeleted: 0,
  interviewRetentionObjectFailures: 0,
  interviewSchedulesStale: 0,
}

const startTime = Date.now()

export const metrics = {
  increment(name: keyof Counters, by = 1) {
    counters[name] += by
  },
  get(): Counters & { uptimeMs: number; uptimeSeconds: number } {
    return {
      ...counters,
      uptimeMs: Date.now() - startTime,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    }
  },
  reset() {
    // Every key, derived. The previous version listed them by hand, so a counter added later would have
    // survived every reset and made a test that reset between cases read a previous case's number.
    for (const key of Object.keys(counters) as Array<keyof Counters>) counters[key] = 0
  },
}
