#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('tsx/cjs')

const { createE2EWorkerDatabase } = require('../../src/shared/lib/db/create-disposable-test-database.ts')

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate an E2E worker port'))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

const workerIndex = Number.parseInt(process.argv[2] ?? process.env.TEST_PARALLEL_INDEX ?? '0', 10)
const runId = process.env.E2E_RUN_ID ?? `run-${process.pid}`
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
const database = await createE2EWorkerDatabase(workerIndex)
const port = await reservePort()
const baseUrl = `http://127.0.0.1:${port}`

const child = spawn('pnpm', ['exec', 'vite', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...database.urls,
    APP_URL: baseUrl,
    VITE_APP_URL: baseUrl,
    E2E_MODE: 'true',
    E2E_RUN_ID: runId,
    E2E_REDIS_PREFIX: `e2e:${runId}:w${workerIndex}`,
    REDIS_URL: redisUrl,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
process.stdout.write(`${JSON.stringify({ workerIndex, port, baseUrl, databaseName: database.databaseName })}\n`)

let stopping = false
async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  child.kill('SIGTERM')
  await database.drop().catch((error) => console.error(error))
  process.exit(exitCode)
}

process.on('SIGINT', () => void stop(130))
process.on('SIGTERM', () => void stop(143))
child.on('exit', (code) => void stop(code ?? 1))
