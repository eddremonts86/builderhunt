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
  let output = ''
  child.stdout?.on('data', (chunk) => { output += String(chunk) })
  child.stderr?.on('data', (chunk) => { output += String(chunk) })
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
