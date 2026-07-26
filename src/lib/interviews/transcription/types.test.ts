import { describe, expect, it } from 'vitest'
import type { TranscriptionProvider, TranscriptionUsage } from './types'

/** Proves `TranscriptionProvider` is implementable with zero I/O and no `deepgram`/websocket package import. */
class FakeTranscriptionProvider implements TranscriptionProvider {
  async issueEphemeralToken(request: { language: string; channels: 1 | 2; multichannel: boolean }) {
    return {
      token: `fake-token-${request.language}-${request.channels}`,
      expiresAt: new Date(30_000).toISOString(),
      websocketUrl: 'wss://fake.local/v1/listen',
    }
  }

  async getUsage(params: { providerRequestId: string }): Promise<TranscriptionUsage> {
    return { providerRequestId: params.providerRequestId, billedSeconds: 42 }
  }
}

describe('TranscriptionProvider', () => {
  it('a fake adapter issues an ephemeral token carrying the requested config', async () => {
    const provider = new FakeTranscriptionProvider()
    const token = await provider.issueEphemeralToken({ language: 'en', channels: 2, multichannel: true })
    expect(token.token).toContain('en-2')
    expect(token.websocketUrl).toMatch(/^wss:\/\//)
  })

  it('a fake adapter returns normalized usage keyed by providerRequestId', async () => {
    const provider = new FakeTranscriptionProvider()
    const usage = await provider.getUsage({ providerRequestId: 'req-1' })
    expect(usage).toEqual({ providerRequestId: 'req-1', billedSeconds: 42 })
  })
})
