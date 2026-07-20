import { describe, expect, it } from 'vitest'
import { parseEnvironment } from './env'

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://builderhunt_app:runtime-secret@db:5432/builderhunt',
  DATABASE_MIGRATION_URL: 'postgresql://migration_operator:owner-secret@db:5432/builderhunt',
  DATABASE_AUTH_URL: 'postgresql://builderhunt_auth:auth-secret@db:5432/builderhunt',
  APP_URL: 'https://builderhunt.example',
  VITE_APP_URL: 'https://builderhunt.example',
  BETTER_AUTH_SECRET: 'a-production-secret-with-more-than-32-characters',
}

describe('production environment security', () => {
  it('accepts separated runtime and migration identities', () => {
    const parsed = parseEnvironment(productionEnvironment)
    expect(parsed.DATABASE_WORKER_URL).toBeUndefined()
    expect(parsed).toMatchObject({
      TENANT_READ_MODE: 'legacy',
      TENANT_WRITE_MODE: 'legacy',
      TENANT_CANONICAL_READY: false,
    })
  })

  it('parses explicit tenant migration gates without permissive boolean coercion', () => {
    expect(parseEnvironment({ ...productionEnvironment, TENANT_CANONICAL_READY: 'true' }).TENANT_CANONICAL_READY).toBe(true)
    expect(() => parseEnvironment({ ...productionEnvironment, TENANT_CANONICAL_READY: 'yes' })).toThrow()
    expect(() => parseEnvironment({ ...productionEnvironment, TENANT_READ_MODE: 'on' })).toThrow()
  })

  it.each([
    ['owner runtime role', { DATABASE_URL: 'postgresql://builderhunt_owner:x@db:5432/builderhunt' }],
    ['postgres runtime role', { DATABASE_URL: 'postgresql://postgres:x@db:5432/builderhunt' }],
    ['shared migration URL', { DATABASE_MIGRATION_URL: productionEnvironment.DATABASE_URL }],
    ['shared auth URL', { DATABASE_AUTH_URL: productionEnvironment.DATABASE_URL }],
    ['weak auth secret', { BETTER_AUTH_SECRET: 'change_me' }],
  ])('rejects %s', (_label, override) => {
    expect(() => parseEnvironment({ ...productionEnvironment, ...override })).toThrow()
  })
})
