import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import type { WorkerDatabase } from './database'
import type { WorkerRedis } from './cache'

export interface WorkerServer {
  workerIndex: number
  port: number
  baseURL: string
  process: ChildProcess
}

const servers = new Map<number, WorkerServer>()

async function freePort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to allocate E2E server port')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

/**
 * `vite dev`, and not `vite preview` — which was tried, measured and reverted on 2026-08-09.
 *
 * The idea was sound on paper: each spec file gets its own server, and under `dev` that server
 * starts with nothing compiled, so the first request pays to transform the route tree and
 * everything it imports. Serving a build instead would skip that, and would test the bundle users
 * actually receive rather than one adjacent to it.
 *
 * It does not work, for a reason no amount of tuning fixes. `VITE_APP_URL` is inlined into the
 * client bundle at build time, and every worker server here listens on a *different* ephemeral
 * port. A pre-built client therefore calls whatever origin was baked in — observed as
 * `third-party egress: http://localhost:3010/api/auth/get-session` from a page served on
 * 127.0.0.1:51983, and a CORS failure behind it. One build cannot serve N origins. Twelve specs in
 * `public-and-consent.spec.ts` failed exactly that way.
 *
 * The measurement did not justify pursuing it either: a page-heavy spec went 47s → 33s, but a
 * five-file batch went 188s → 189s. The compile cost is real and mostly paid once per process, not
 * once per request, so a warm machine barely notices it. CI, cold and two-core, would gain more —
 * but not enough to justify either baking a fixed port (which breaks any parallel local run) or
 * moving the app to relative API URLs (a product change, with its own risk, for a test speedup).
 *
 * If someone revisits this: the blocker is the baked origin, not the server mode.
 */
export async function startWorkerServer(
  workerIndex: number,
  database: WorkerDatabase,
  cache: WorkerRedis,
): Promise<WorkerServer> {
  const existing = servers.get(workerIndex)
  if (existing) return existing
  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`
  const child = spawn('pnpm', ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...database.urls,
      APP_URL: baseURL,
      VITE_APP_URL: baseURL,
      E2E_MODE: 'true',
      E2E_REDIS_PREFIX: cache.prefix,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  /**
   * The child's output is buffered for the startup-failure message, and forwarded only when
   * `E2E_SERVER_LOG=1`.
   *
   * Every route in this app answers a coded error and logs the cause server-side — which is right,
   * and means a failing assertion shows `{"error":"invalid_input"}` with the reason sitting in a
   * string no one reads. Silently forwarding it always would bury the reporter under Vite noise, so
   * it is one env var away instead of a code edit away.
   */
  const forward = process.env.E2E_SERVER_LOG === '1'
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += String(chunk)
    if (forward) process.stderr.write(`[w${workerIndex}] ${chunk}`)
  })
  child.stderr?.on('data', (chunk) => {
    output += String(chunk)
    if (forward) process.stderr.write(`[w${workerIndex}] ${chunk}`)
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Worker Vite exited (${child.exitCode}):\n${output}`)
    try {
      const response = await fetch(`${baseURL}/api/health`)
      if (response.ok) {
        const handle = { workerIndex, port, baseURL, process: child }
        servers.set(workerIndex, handle)
        return handle
      }
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  child.kill('SIGTERM')
  throw new Error(`Worker Vite did not become healthy:\n${output}`)
}

export async function stopWorkerServer(workerIndex: number): Promise<void> {
  const server = servers.get(workerIndex)
  if (!server) return
  servers.delete(workerIndex)
  if (server.process.exitCode !== null) return
  server.process.kill('SIGTERM')
  await Promise.race([
    once(server.process, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (server.process.exitCode === null) server.process.kill('SIGKILL')
}
