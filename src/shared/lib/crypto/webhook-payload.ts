/**
 * AES-256-GCM encryption for the minimized Stripe webhook payload retained in
 * `billing_webhook_events.payload_encrypted` (spec.md §Operations: "Raw financial payload access is
 * platform-only, minimized, encrypted where retained, redacted from logs/errors, and deleted on
 * schedule."). Never used for anything else — this is not a general-purpose encryption utility.
 *
 * GCM gives both confidentiality and integrity (a tampered ciphertext fails to decrypt rather than
 * silently returning garbage). A fresh random IV is generated per encryption and stored alongside
 * the ciphertext/auth tag in the single persisted string — GCM's security depends on never reusing
 * an IV with the same key, and this call site encrypts once per webhook event, not in a loop where
 * an incrementing counter would be simpler to get right.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../env'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH_BYTES = 12
const KEY_LENGTH_BYTES = 32

export class WebhookPayloadEncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookPayloadEncryptionError'
  }
}

function resolveKey(): Buffer {
  const hex = env.WEBHOOK_PAYLOAD_ENCRYPTION_KEY
  if (!hex) {
    throw new WebhookPayloadEncryptionError('WEBHOOK_PAYLOAD_ENCRYPTION_KEY is not configured')
  }
  const key = Buffer.from(hex, 'hex')
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new WebhookPayloadEncryptionError(`WEBHOOK_PAYLOAD_ENCRYPTION_KEY must decode to ${KEY_LENGTH_BYTES} bytes`)
  }
  return key
}

/** Stored format: `iv:authTag:ciphertext`, each hex-encoded — a single text column, no JSON wrapper needed. */
export function encryptWebhookPayload(plaintext: string, key: Buffer = resolveKey()): string {
  const iv = randomBytes(IV_LENGTH_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

export function decryptWebhookPayload(stored: string, key: Buffer = resolveKey()): string {
  const parts = stored.split(':')
  if (parts.length !== 3) {
    throw new WebhookPayloadEncryptionError('Malformed encrypted payload — expected iv:authTag:ciphertext')
  }
  const [ivHex, authTagHex, ciphertextHex] = parts
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()])
  return plaintext.toString('utf8')
}
