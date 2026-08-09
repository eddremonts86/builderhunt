import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
 * `vite preview` — the built app, not the dev server.
 *
 * Each spec file gets its own server, and under `dev` that server starts with nothing compiled, so
 * the first request pays to transform the route tree and everything it imports. Serving a build
 * skips that, and tests the bundle a user actually receives rather than one adjacent to it.
 *
 * This was tried once and reverted, because a built client called the origin baked into it at build
 * time — `http://localhost:3010/api/auth/get-session` from a page served on 127.0.0.1:51983 — and
 * the browser blocked it on CORS. Twelve `public-and-consent` specs failed that way. The blocker was
 * never the server mode: it was `auth/client.ts` passing `import.meta.env.VITE_APP_URL` as its
 * `baseURL`, which Vite replaces statically. A same-origin client now asks for
 * `window.location.origin`, one build serves any origin, and the same batch that failed goes green.
 *
 * Measured on that batch, five files: dev 188s, preview 144s. The first attempt read 189s and
 * looked like no gain at all — that number was twelve failing specs burning their retries, not the
 * server mode.
 *
 * `E2E_SERVER_MODE=dev` opts out, for iterating on source without rebuilding between runs.
 */
function serverArgv(): string[] {
  if (process.env.E2E_SERVER_MODE === 'dev') return ['dev']
  if (!existsSync(join(process.cwd(), 'dist'))) {
    throw new Error(
      'The E2E harness serves a production build and none exists. Run `pnpm build` first, or set '
      + 'E2E_SERVER_MODE=dev to use the dev server — slower, and not what CI measures.',
    )
  }
  return ['preview']
}

export async function startWorkerServer(
  workerIndex: number,
  database: WorkerDatabase,
  cache: WorkerRedis,
): Promise<WorkerServer> {
  const existing = servers.get(workerIndex)
  if (existing) return existing
  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`
  const child = spawn('pnpm', ['exec', 'vite', ...serverArgv(), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...database.urls,
      APP_URL: baseURL,
      VITE_APP_URL: baseURL,
      // `vite preview` sets NODE_ENV=production, and five places in the app change behaviour on it —
      // `test-trigger.ts` answers 404 outright, stepup and the capability session relax differently.
      // The point of serving the build is to run the *bundle* that ships, not to run it in an
      // environment no test has ever used: `vite dev` was NODE_ENV=development and the suite was
      // written against that. Pinning it back keeps the artefact and drops the surprise.
      NODE_ENV: 'test',
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
