import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptWebhookPayload, encryptWebhookPayload, WebhookPayloadEncryptionError } from './webhook-payload'

const KEY = randomBytes(32)
const OTHER_KEY = randomBytes(32)

describe('encryptWebhookPayload / decryptWebhookPayload', () => {
  it('round-trips a plaintext payload', () => {
    const plaintext = JSON.stringify({ id: 'evt_123', type: 'checkout.session.completed' })
    const encrypted = encryptWebhookPayload(plaintext, KEY)
    expect(decryptWebhookPayload(encrypted, KEY)).toBe(plaintext)
  })

  it('produces a different ciphertext each time (fresh IV per call)', () => {
    const plaintext = 'same payload'
    const first = encryptWebhookPayload(plaintext, KEY)
    const second = encryptWebhookPayload(plaintext, KEY)
    expect(first).not.toBe(second)
    expect(decryptWebhookPayload(first, KEY)).toBe(plaintext)
    expect(decryptWebhookPayload(second, KEY)).toBe(plaintext)
  })

  it('stores as iv:authTag:ciphertext, all hex', () => {
    const encrypted = encryptWebhookPayload('x', KEY)
    const parts = encrypted.split(':')
    expect(parts).toHaveLength(3)
    for (const part of parts) expect(part).toMatch(/^[0-9a-f]*$/)
  })

  it('fails to decrypt with the wrong key (GCM auth tag mismatch, not silent garbage)', () => {
    const encrypted = encryptWebhookPayload('secret payload', KEY)
    expect(() => decryptWebhookPayload(encrypted, OTHER_KEY)).toThrow()
  })

  it('fails to decrypt a tampered ciphertext', () => {
    const encrypted = encryptWebhookPayload('secret payload', KEY)
    const [iv, authTag, ciphertext] = encrypted.split(':')
    const tamperedByte = ciphertext.slice(0, -2) + (ciphertext.slice(-2) === '00' ? '01' : '00')
    expect(() => decryptWebhookPayload(`${iv}:${authTag}:${tamperedByte}`, KEY)).toThrow()
  })

  it('fails to decrypt a tampered auth tag', () => {
    const encrypted = encryptWebhookPayload('secret payload', KEY)
    const [iv, authTag, ciphertext] = encrypted.split(':')
    const tamperedTag = authTag.slice(0, -2) + (authTag.slice(-2) === '00' ? '01' : '00')
    expect(() => decryptWebhookPayload(`${iv}:${tamperedTag}:${ciphertext}`, KEY)).toThrow()
  })

  it('rejects a malformed stored value', () => {
    expect(() => decryptWebhookPayload('not-the-right-format', KEY)).toThrow(WebhookPayloadEncryptionError)
    expect(() => decryptWebhookPayload('a:b', KEY)).toThrow(WebhookPayloadEncryptionError)
  })

  it('rejects a key of the wrong length (Node crypto itself enforces this)', () => {
    expect(() => encryptWebhookPayload('x', randomBytes(16))).toThrow()
  })

  it('fails closed when no key is supplied and WEBHOOK_PAYLOAD_ENCRYPTION_KEY is unset in this environment', () => {
    // This dev/test environment runs with STRIPE_BILLING_ENABLED=false, so env.ts never required
    // WEBHOOK_PAYLOAD_ENCRYPTION_KEY to be set — confirms the default-parameter path fails closed
    // rather than falling back to some implicit key.
    expect(() => encryptWebhookPayload('x')).toThrow(WebhookPayloadEncryptionError)
  })
})
