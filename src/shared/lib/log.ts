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

const sensitiveKey = /authorization|cookie|database.*url|email|export.*payload|pass(word)?|prompt|response|secret|token/i

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
