import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env'

const workerClient = postgres(env.DATABASE_WORKER_URL ?? env.DATABASE_URL, { prepare: false })

export const workerDb = drizzle(workerClient)
export type WorkerTransaction = Parameters<Parameters<typeof workerDb.transaction>[0]>[0]
