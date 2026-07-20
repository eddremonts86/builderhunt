import { describe, expect, it } from 'vitest'
import { parseEnvironment } from './env'

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://builderhunt_app:runtime-secret@db:5432/builderhunt',
  DATABASE_MIGRATION_URL: 'postgresql://migration_operator:owner-secret@db:5432/builderhunt',
  APP_URL: 'https://builderhunt.example',
  VITE_APP_URL: 'https://builderhunt.example',
  BETTER_AUTH_SECRET: 'a-production-secret-with-more-than-32-characters',
}

describe('production environment security', () => {
  it('accepts separated runtime and migration identities', () => {
    expect(parseEnvironment(productionEnvironment).DATABASE_WORKER_URL).toBeUndefined()
  })

  it.each([
    ['owner runtime role', { DATABASE_URL: 'postgresql://builderhunt_owner:x@db:5432/builderhunt' }],
    ['postgres runtime role', { DATABASE_URL: 'postgresql://postgres:x@db:5432/builderhunt' }],
    ['shared migration URL', { DATABASE_MIGRATION_URL: productionEnvironment.DATABASE_URL }],
    ['weak auth secret', { BETTER_AUTH_SECRET: 'change_me' }],
  ])('rejects %s', (_label, override) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...override })).toThrow()
  })
})
