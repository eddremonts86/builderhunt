/**
 * @vitest-environment node
 *
 * Sockets, not a DOM. Nothing here needs a simulated browser, and the project
 * default (`happy-dom`) only adds globals a TCP client will never touch.
 */
/**
 * Two layers, because they answer different questions.
 *
 * The fake-clamd cases drive failure modes a real scanner will not produce on
 * demand — a socket that accepts and says nothing, a reply that never arrives,
 * a garbled line. Those are precisely the paths where "we could not check"
 * could silently become "it was clean", so they need to be reachable in a test.
 *
 * The EICAR case runs against the real container, because a scanner that starts
 * but never detects returns a clean verdict, and no fake can tell you whether
 * the deployed one actually matches signatures.
 */
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ClamAvScanner, parseClamdReply, type ObjectReader } from '~/lib/storage/clamav'
import { ScanProviderError } from '~/lib/storage/types'

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

function readerFor(body: string): ObjectReader {
  const bytes = Buffer.from(body)
  return async () => ({
    bytes: bytes.length,
    stream: (async function* () { yield bytes })(),
  })
}

/** A minimal clamd stand-in. `behaviour` decides what it does once the stream ends. */
async function fakeClamd(behaviour: (socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const live = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))
    socket.on('error', () => undefined)
    behaviour(socket)
    // Drain whatever the scanner sends. A socket nobody reads from stays
    // paused, so it never observes the client's FIN and never emits 'close' —
    // and the scenarios below that deliberately say nothing back are exactly
    // the ones with no reason to read. Harmless where `behaviour` already
    // attached a 'data' listener: the socket is flowing by then.
    socket.resume()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      // Destroy before closing. `server.close()` stops accepting but waits on
      // live connections, and a fake that never replies holds one open forever
      // — which hung this suite until vitest's 120s limit rather than the
      // sub-second rejection the scanner actually performs.
      for (const socket of live) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

describe('parseClamdReply', () => {
  it('reads the three replies clamd actually sends', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'clean', detailCode: null })
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND\0'))
      .toEqual({ status: 'infected', detailCode: 'Eicar-Test-Signature' })
    expect(parseClamdReply('stream: Encrypted.Archive ERROR\0'))
      .toEqual({ status: 'error', detailCode: 'Encrypted.Archive' })
  })

  it('does not read an unrecognised reply as clean', () => {
    // The failure that matters: anything unparseable must fall to `error`. If
    // this ever returns `clean`, a desynchronised socket promotes an unscanned
    // document to the clean prefix.
    for (const reply of ['', 'garbage', 'stream:', 'PONG', '<html>502 Bad Gateway</html>']) {
      expect(parseClamdReply(reply).status, `reply ${JSON.stringify(reply)}`).not.toBe('clean')
    }
  })
})

describe('ClamAvScanner failure paths never report clean', () => {
  const servers: Array<() => Promise<void>> = []
  afterEach(async () => { for (const close of servers.splice(0)) await close() })

  it('rejects when nothing is listening', async () => {
    // Port 1 on loopback: reserved and never bound.
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 }, readerFor('hello'))
    await expect(scanner.scanObject({ key: 'k' })).rejects.toMatchObject({
      name: 'ScanProviderError',
      code: 'provider_unavailable',
    })
  })

  it('rejects when the scanner accepts and then says nothing', async () => {
    const fake = await fakeClamd(() => undefined)
    servers.push(fake.close)
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 600 }, readerFor('hello'))
    await expect(scanner.scanObject({ key: 'k' })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects when the scanner closes without replying', async () => {
    const fake = await fakeClamd((socket) => { socket.end() })
    servers.push(fake.close)
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 2000 }, readerFor('hello'))
    await expect(scanner.scanObject({ key: 'k' })).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('reports error, not clean, for a garbled reply', async () => {
    const fake = await fakeClamd((socket) => { setTimeout(() => socket.end('not a clamd reply\0'), 20) })
    servers.push(fake.close)
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 2000 }, readerFor('hello'))
    const result = await scanner.scanObject({ key: 'k' })
    expect(result.status).toBe('error')
  })

  it('refuses an oversized object before opening a socket', async () => {
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1, maxBytes: 4 }, readerFor('far too long'))
    await expect(scanner.scanObject({ key: 'k' })).rejects.toMatchObject({ code: 'object_too_large' })
  })

  it('surfaces a storage failure as provider_unavailable rather than a verdict', async () => {
    const failing: ObjectReader = async () => { throw new Error('bucket unreachable') }
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: 1 }, failing)
    await expect(scanner.scanObject({ key: 'k' })).rejects.toBeInstanceOf(ScanProviderError)
  })

  it('sends a well-formed INSTREAM frame', async () => {
    // Proves the wire format rather than trusting it: command line, one
    // length-prefixed chunk, and the zero-length terminator.
    let received = Buffer.alloc(0)
    const fake = await fakeClamd((socket) => {
      // Typed explicitly: the 'data' payload is `Buffer | string` because a
      // socket with an encoding set emits strings, and this one has none.
      socket.on('data', (d: Buffer) => {
        received = Buffer.concat([received, d])
        if (received.length >= 'zINSTREAM\0'.length + 4 + 5 + 4) socket.end('stream: OK\0')
      })
    })
    servers.push(fake.close)
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: fake.port, timeoutMs: 3000 }, readerFor('hello'))
    expect((await scanner.scanObject({ key: 'k' })).status).toBe('clean')

    expect(received.subarray(0, 10).toString()).toBe('zINSTREAM\0')
    expect(received.readUInt32BE(10), 'chunk length prefix').toBe(5)
    expect(received.subarray(14, 19).toString()).toBe('hello')
    expect(received.readUInt32BE(19), 'zero-length terminator').toBe(0)
  })
})

const clamavHost = process.env.INTERVIEW_CLAMAV_HOST
const clamavPort = Number(process.env.INTERVIEW_CLAMAV_PORT ?? 3310)

describe.skipIf(!clamavHost)('ClamAvScanner against the real scanner', () => {
  it('detects EICAR', async () => {
    const scanner = new ClamAvScanner({ host: clamavHost!, port: clamavPort }, readerFor(EICAR))
    const result = await scanner.scanObject({ key: 'eicar' })
    expect(result.status).toBe('infected')
    expect(result.detailCode).toMatch(/Eicar/i)
  })

  it('passes an ordinary document', async () => {
    const scanner = new ClamAvScanner({ host: clamavHost!, port: clamavPort }, readerFor('an ordinary CV, nothing hidden'))
    expect((await scanner.scanObject({ key: 'clean' })).status).toBe('clean')
  })
})
