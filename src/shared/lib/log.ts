// Structured JSON logger for server contexts.
// Emits one JSON object per line — easy to grep, easy to ship to Loki/CloudWatch.

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogContext {
  [key: string]: unknown
}

function emit(level: LogLevel, event: string, ctx: LogContext = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  }
  const line = JSON.stringify(entry)
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
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
