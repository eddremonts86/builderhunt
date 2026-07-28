/**
 * `VirusScanProvider` over clamd's `INSTREAM` command (plan:
 * calendar-scheduling-interview-intelligence, Phase 6).
 *
 * ## The one rule
 *
 * **An unavailable scanner must never produce `clean`.** Every failure path here
 * either throws `ScanProviderError` or returns `status: 'error'`; none of them
 * can reach `clean`. That sounds obvious and is the exact bug worth guarding
 * against, because the shape that invites it is so natural — a `try/catch`
 * around the socket that falls through to a default result, or a timeout that
 * resolves instead of rejecting. Both turn "we could not check" into "we
 * checked and it was fine", which is the worst possible answer: the document
 * gets promoted to the clean prefix and served to an organizer.
 *
 * The two outcomes are deliberately different types, because callers act on
 * them differently:
 *
 *   - `ScanProviderError` — infrastructure. Retry later; the document stays
 *     quarantined with `scan_status = 'pending'`.
 *   - `ScanResult{ status: 'error' }` — clamd answered, and its answer was that
 *     it could not scan this object (encrypted archive, nesting limit). Retrying
 *     will produce the same thing, so the document is rejected rather than
 *     requeued.
 *
 * ## Protocol
 *
 * `zINSTREAM\0`, then a sequence of `<uint32 big-endian length><bytes>` chunks,
 * then a zero-length chunk to end the stream. clamd replies with a single
 * NUL-terminated line: `stream: OK`, `stream: <signature> FOUND`, or
 * `stream: <reason> ERROR`.
 *
 * `z` rather than `n` prefix: the `z` variants are NUL-terminated, which is
 * unambiguous. The `n` variants are newline-terminated and a signature name
 * containing a newline would desynchronise the reply parser.
 */
import net from 'node:net'
import { ScanProviderError, type ScanResult, type VirusScanProvider } from './types'

export interface ClamAvConfig {
  host: string
  port: number
  /**
   * Must stay at or below clamd's own `StreamMaxLength` (64 MB in
   * `docker/clamav/Dockerfile`). If this is the larger of the two, clamd aborts
   * mid-stream and the caller sees a truncated-reply error instead of a clean
   * "too large" refusal.
   */
  maxBytes?: number
  timeoutMs?: number
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
/** clamd's own INSTREAM chunk ceiling is
 * `StreamMaxLength`; 64 KiB keeps memory flat and is well inside it. */
const CHUNK_BYTES = 64 * 1024

/** Reads an object's bytes. Injected so the scanner does not depend on a storage vendor. */
export type ObjectReader = (key: string) => Promise<{ bytes: number; stream: AsyncIterable<Uint8Array> }>

export function parseClamdReply(reply: string): ScanResult {
  const line = reply.replace(/\0+$/, '').trim()
  if (/\bOK$/.test(line)) return { status: 'clean', detailCode: null }
  const found = line.match(/^stream:\s*(.+?)\s+FOUND$/)
  if (found) return { status: 'infected', detailCode: found[1] }
  const error = line.match(/^stream:\s*(.+?)\s+ERROR$/)
  if (error) return { status: 'error', detailCode: error[1] }
  // An unrecognised reply is NOT clean. clamd's vocabulary is small and stable,
  // so anything else means the connection desynchronised or something other
  // than clamd answered.
  return { status: 'error', detailCode: `unrecognised_reply:${line.slice(0, 120)}` }
}

export class ClamAvScanner implements VirusScanProvider {
  private readonly maxBytes: number
  private readonly timeoutMs: number

  constructor(private readonly config: ClamAvConfig, private readonly readObject: ObjectReader) {
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async scanObject(params: { key: string }): Promise<ScanResult> {
    const object = await this.readObject(params.key).catch((error: unknown) => {
      throw new ScanProviderError(
        `could not read ${params.key} for scanning: ${error instanceof Error ? error.message : String(error)}`,
        'provider_unavailable',
      )
    })

    // Refused before a byte is sent. clamd would otherwise accept the stream up
    // to its own limit and then abort, which surfaces as a protocol error and
    // looks like the scanner is broken.
    if (object.bytes > this.maxBytes) {
      throw new ScanProviderError(
        `object is ${object.bytes} bytes, above the ${this.maxBytes}-byte scan limit`,
        'object_too_large',
      )
    }

    return this.stream(object.stream)
  }

  private stream(source: AsyncIterable<Uint8Array>): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      const socket = net.createConnection({ host: this.config.host, port: this.config.port })
      const chunks: Buffer[] = []
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        socket.destroy()
        fn()
      }

      // A hard deadline on the whole exchange, not just on socket idleness: a
      // scanner that dribbles bytes forever would otherwise never trip an
      // inactivity timeout, and the upload would hang rather than quarantine.
      const deadline = setTimeout(() => {
        finish(() => reject(new ScanProviderError(`scan exceeded ${this.timeoutMs}ms`, 'timeout')))
      }, this.timeoutMs)
      deadline.unref?.()

      socket.setTimeout(this.timeoutMs)
      socket.on('timeout', () => {
        clearTimeout(deadline)
        finish(() => reject(new ScanProviderError('scanner stopped responding', 'timeout')))
      })
      socket.on('error', (error) => {
        clearTimeout(deadline)
        finish(() => reject(new ScanProviderError(`scanner unreachable: ${error.message}`, 'provider_unavailable')))
      })
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('close', () => {
        clearTimeout(deadline)
        if (settled) return
        settled = true
        const reply = Buffer.concat(chunks).toString('utf8')
        // A closed connection with nothing said is not a clean verdict.
        if (reply.length === 0) {
          reject(new ScanProviderError('scanner closed the connection without replying', 'provider_unavailable'))
          return
        }
        resolve(parseClamdReply(reply))
      })

      socket.on('connect', () => {
        void (async () => {
          try {
            socket.write('zINSTREAM\0')
            for await (const piece of source) {
              for (let offset = 0; offset < piece.length; offset += CHUNK_BYTES) {
                const slice = Buffer.from(piece.subarray(offset, offset + CHUNK_BYTES))
                const header = Buffer.alloc(4)
                header.writeUInt32BE(slice.length, 0)
                socket.write(header)
                socket.write(slice)
              }
            }
            // Zero-length chunk: the end-of-stream marker. Without it clamd
            // waits for more data until its own timeout and the reply never
            // arrives.
            const terminator = Buffer.alloc(4)
            terminator.writeUInt32BE(0, 0)
            socket.write(terminator)
          } catch (error) {
            clearTimeout(deadline)
            finish(() => reject(new ScanProviderError(
              `failed while streaming to the scanner: ${error instanceof Error ? error.message : String(error)}`,
              'provider_unavailable',
            )))
          }
        })()
      })
    })
  }
}
