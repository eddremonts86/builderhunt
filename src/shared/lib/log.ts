// Structured JSON logger for server contexts.
// Emits one JSON object per line — easy to grep, easy to ship to Loki/CloudWatch.

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogContext {
  [key: string]: unknown
}

function emit(level: LogLevel, event: string, ctx: LogContext = {}) {
  const entry = redactLogValue({
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  })
  const line = JSON.stringify(entry)
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

/**
 * Keys whose value never reaches a log, whatever it holds.
 *
 * Extended 2026-07-28 for interview intelligence. The additions are not hypothetical: a transcript segment, a
 * CV's extracted text, an object key, and a capability secret all pass through code that logs on failure, and
 * "the error message happened to include it" is how a candidate's words end up in a log aggregator with a
 * different retention policy from the table they were deleted from.
 *
 * Matched on the key rather than sniffed from the value, because a value-based guess cannot tell a transcript
 * line from an error message — and the failure is one-directional: a redacted field costs a debugging session,
 * a leaked one is a disclosure.
 */
const sensitiveKey = new RegExp([
  // Pre-existing.
  'authorization', 'cookie', 'database.*url', 'email', 'export.*payload', 'pass(word)?', 'prompt',
  'response', 'secret', 'token', 'profileurl', 'sourceurl', 'submittedurls', 'payload', 'bio',
  'displayname', 'location',
  // Interview material: what a candidate wrote, said, or was assessed on.
  'transcript', 'segment.*text', '^text$', 'plaintext', 'plain_text', 'extractedtext', 'extracted_text',
  'candidatesummary', 'candidate_summary', 'rationale', 'statement', 'answer', 'question',
  'summary', 'content', 'roleContext', 'role_context', 'notes', 'organizernotes', 'organizer_notes',
  // Locations and credentials for private storage.
  'objectkey', 'object_key', 'signedurl', 'signed_url', 'downloadurl', 'download_url', 'uploadurl',
  'capability', 'capabilityhash', 'capability_hash', 'accesstoken', 'access_token',
  // Candidate identity.
  'candidateemail', 'candidate_email', 'emailnormalized', 'email_normalized', 'subjectemailhash',
  'subject_email_hash', 'originalname', 'original_name', 'candidatename', 'candidate_name',
  // Provider and payment material.
  'apikey', 'api_key', 'stripe.*(secret|key)', 'client_secret', 'clientsecret',
].join('|'), 'i')

export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry, seen))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  const redacted: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = sensitiveKey.test(key) ? '[REDACTED]' : redactLogValue(entry, seen)
  }
  return redacted
}

function redactString(value: string) {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(token|secret|password|code)=([^\s&,;]+)/gi, '$1=[REDACTED]')
    // A capability arrives in a URL fragment, which the credential patterns above do not touch: there is no
    // `token=` and no `Bearer`, just `#<secret>`. It is the entire authorization for the candidate portal.
    .replace(/(\/schedule\/[0-9a-f-]{36})#\S+/gi, '$1#[REDACTED]')
    // A presigned URL's signature. The whole query string goes, because `X-Amz-Signature` is only the last of
    // several parts that together make the URL usable.
    .replace(/(https?:\/\/[^\s?]+\?)[^\s]*X-Amz-[^\s]*/gi, '$1[REDACTED_SIGNED_URL]')
    // Stripe secrets and restricted keys, which appear in provider error bodies.
    .replace(/\b(sk|rk)_(test|live)_[A-Za-z0-9]+/g, '[REDACTED_STRIPE_KEY]')
    // Deepgram and Mistral keys, both long opaque tokens with recognisable prefixes.
    .replace(/\bTokenΩ?\s+[A-Za-z0-9]{20,}/g, 'Token [REDACTED]')
}

export const log = {
  debug(event: string, ctx?: LogContext) {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', event, ctx)
  },
  info(event: string, ctx?: LogContext) {
    emit('info', event, ctx)
  },
  warn(event: string, ctx?: LogContext) {
    emit('warn', event, ctx)
  },
  error(event: string, ctx: LogContext & { error?: unknown }) {
    const err = ctx.error
    if (err instanceof Error) {
      emit('error', event, {
        ...ctx,
        error: err.message,
        stack: err.stack,
        name: err.name,
      })
    } else {
      emit('error', event, ctx)
    }
  },
}

/**
 * Wraps an async function with structured error logging.
 * Usage: const result = await logged('search_executed', { userId }, () => searchBuilders(...))
 */
export async function logged<T>(
  event: string,
  ctx: LogContext,
  fn: () => Promise<T>,
): Promise<T | null> {
  const start = Date.now()
  try {
    const result = await fn()
    log.info(event, { ...ctx, durationMs: Date.now() - start, ok: true })
    return result
  } catch (err) {
    log.error(event, { ...ctx, durationMs: Date.now() - start, ok: false, error: err })
    return null
  }
}
