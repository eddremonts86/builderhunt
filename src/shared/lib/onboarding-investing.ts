/**
 * Saving a thesis as a search, and arming it (plan: phase-2/03-onboarding-segmentado).
 *
 * ## Why arming is a separate outcome rather than a step that can fail
 *
 * The spec's activation for this route is "the first saved search with an alert/radar" — a search
 * that is actually *watching*, not a row in a list. Alerts are a paid feature (`/api/alerts` answers
 * 402 without `paidActionsAllowed`), and a brand-new organization is on `free`. Left there, the
 * investing route could only activate somebody who had already paid, and its activation rate would
 * measure conversion to Pro rather than whether the route works.
 *
 * So arming has two real forms, and the caller is told which one happened:
 *
 * - **alert** — the paid path. A row in `alerts` tied to the saved query, evaluated by the worker.
 * - **feed** — the free path. A minted feed capability: a private RSS URL that serves that query's
 *   results. Ungated, already built, and genuinely a subscription — the search delivers to somebody
 *   whether or not they pay.
 *
 * Both are rows the server can count, which is what keeps the activation honest. What this module
 * never does is report success for a search nobody will hear from: `none` is a real outcome and the
 * interface says so rather than claiming an alert exists.
 *
 * ## Why the fetch is injected
 *
 * The 402 branch is the interesting one and it is unreachable in a test that has to provoke a real
 * billing state. Passing `fetchImpl` makes each outcome a plain unit test.
 */
import { IMPLEMENTED_SEARCH_CONNECTORS } from './search-connectors'

export type ArmOutcome =
  | { armed: 'alert'; alertId: string }
  | { armed: 'feed'; feedUrl: string }
  | { armed: 'none'; reason: string }

export interface SaveAndArmResult {
  queryId: string | null
  outcome: ArmOutcome
  /** Set when the saved search itself could not be created — a plan limit, a rate limit, a 500. */
  error?: string
}

type FetchLike = typeof fetch

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

/**
 * Arms an existing saved search, preferring the alert and falling back to a feed link.
 *
 * Only a 402 falls back. Any other refusal — a rate limit, a validation error, a 500 — is reported
 * as `none` with the server's own message, because those mean something went wrong rather than
 * "this costs money", and silently minting a feed link instead would hide a real failure behind a
 * success the person did not ask for.
 */
export async function armSavedSearch(options: {
  queryId: string
  name: string
  keywords: readonly string[]
  fetchImpl?: FetchLike
}): Promise<ArmOutcome> {
  const doFetch = options.fetchImpl ?? fetch
  const keywords = [...options.keywords]

  let alertResponse: Response
  try {
    alertResponse = await doFetch('/api/alerts', {
      method: 'POST',
      credentials: 'include',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: options.name,
        keywords,
        queryId: options.queryId,
        frequency: 'daily',
        deliveryChannel: 'email',
        triggerConditions: { eventType: 'keyword_match', keywords },
      }),
    })
  } catch {
    return { armed: 'none', reason: 'We could not reach the server to set this up.' }
  }

  if (alertResponse.ok) {
    const body = await readJson(alertResponse)
    return { armed: 'alert', alertId: typeof body.id === 'string' ? body.id : options.queryId }
  }

  if (alertResponse.status !== 402) {
    const body = await readJson(alertResponse)
    return {
      armed: 'none',
      reason: typeof body.error === 'string' ? body.error : `Could not set up alerts (${alertResponse.status}).`,
    }
  }

  // 402: alerts are a paid feature. The free path is a real one, not a consolation.
  try {
    const feedResponse = await doFetch(`/api/queries/${encodeURIComponent(options.queryId)}/feed-capability`, {
      method: 'POST',
      credentials: 'include',
      headers: JSON_HEADERS,
    })
    if (!feedResponse.ok) {
      const body = await readJson(feedResponse)
      return {
        armed: 'none',
        reason: typeof body.error === 'string' ? body.error : `Could not create a feed link (${feedResponse.status}).`,
      }
    }
    const body = await readJson(feedResponse)
    if (typeof body.url !== 'string') {
      return { armed: 'none', reason: 'The feed link came back empty.' }
    }
    return { armed: 'feed', feedUrl: body.url }
  } catch {
    return { armed: 'none', reason: 'We could not reach the server to set this up.' }
  }
}

/**
 * Creates the saved search from a thesis, then arms it.
 *
 * The two halves are reported separately on purpose. A saved search that exists but could not be
 * armed is a partial success worth telling somebody about — theirs to arm later from the alerts page
 * — and collapsing it into one boolean would either throw away a real saved search or claim an alert
 * that is not there.
 */
export async function saveAndArmThesis(options: {
  name: string
  keywords: readonly string[]
  fetchImpl?: FetchLike
}): Promise<SaveAndArmResult> {
  const doFetch = options.fetchImpl ?? fetch
  const keywords = [...options.keywords]

  if (keywords.length === 0) {
    return { queryId: null, outcome: { armed: 'none', reason: 'A thesis needs at least one theme.' }, error: 'empty' }
  }

  let created: Response
  try {
    created = await doFetch('/api/queries', {
      method: 'POST',
      credentials: 'include',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: options.name,
        keywords,
        // The full register rather than a hand-written subset: a thesis that only watched GitHub
        // would quietly be a narrower search than the discovery step it came from.
        sources: [...IMPLEMENTED_SEARCH_CONNECTORS],
      }),
    })
  } catch {
    return {
      queryId: null,
      outcome: { armed: 'none', reason: 'We could not reach the server.' },
      error: 'We could not save that search. You can try again from the dashboard.',
    }
  }

  if (!created.ok) {
    const body = await readJson(created)
    return {
      queryId: null,
      outcome: { armed: 'none', reason: 'The search was not saved.' },
      error: typeof body.error === 'string' ? body.error : `Could not save the search (${created.status}).`,
    }
  }

  const body = await readJson(created)
  if (typeof body.id !== 'string') {
    return {
      queryId: null,
      outcome: { armed: 'none', reason: 'The search was not saved.' },
      error: 'The saved search came back without an id.',
    }
  }

  const outcome = await armSavedSearch({
    queryId: body.id,
    name: options.name,
    keywords,
    fetchImpl: doFetch,
  })
  return { queryId: body.id, outcome }
}
