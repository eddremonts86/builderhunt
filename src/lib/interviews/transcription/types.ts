/**
 * Live transcription provider contract (plan: calendar-scheduling-interview-intelligence,
 * spec.md "Live capture contract": "Browser obtains a 30-second Deepgram token and connects to
 * `wss://api.eu.deepgram.com/v1/listen`..."). No I/O, no vendor SDK import — domain code and
 * routes only see this shape; a real Deepgram-backed adapter lives elsewhere.
 */

export interface TranscriptionCredentialsRequest {
  language: string
  channels: 1 | 2
  multichannel: boolean
}

export interface TranscriptionToken {
  token: string
  /** Always short-lived — spec.md pins this to 30 seconds for the live Deepgram token. */
  expiresAt: string
  websocketUrl: string
}

export interface TranscriptionUsage {
  providerRequestId: string
  billedSeconds: number
}

export type TranscriptionErrorCode = 'provider_unavailable' | 'invalid_credentials' | 'rate_limited' | 'unsupported_configuration'

export class TranscriptionProviderError extends Error {
  constructor(message: string, readonly code: TranscriptionErrorCode) {
    super(message)
    this.name = 'TranscriptionProviderError'
  }
}

export interface TranscriptionProvider {
  issueEphemeralToken(request: TranscriptionCredentialsRequest): Promise<TranscriptionToken>
  getUsage(params: { providerRequestId: string }): Promise<TranscriptionUsage>
}
