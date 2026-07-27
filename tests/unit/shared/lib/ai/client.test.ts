import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('~/shared/lib/ai/tasks', () => ({ getTask: vi.fn() }))
vi.mock('~/shared/lib/ai/capabilities', () => ({ getAICapability: vi.fn() }))
vi.mock('~/shared/lib/ai/local', () => ({ promptLocal: vi.fn() }))

import { getTask } from '~/shared/lib/ai/tasks'
import { getAICapability } from '~/shared/lib/ai/capabilities'
import { promptLocal } from '~/shared/lib/ai/local'
import { ai } from '~/shared/lib/ai/client'
import { AIUnavailableError } from '~/shared/lib/ai/errors'

const outputSchema = z.object({ pong: z.literal(true) })

function fakeTask(overrides: Partial<{ tier: 'local-first' | 'server-only' }> = {}) {
  return {
    id: 'ping',
    tier: overrides.tier ?? 'server-only',
    inputSchema: z.object({}),
    outputSchema,
    system: 'system prompt',
    buildPrompt: () => 'prompt',
    cacheTtlSeconds: null,
    allowances: { free: 5, pro: 20, team: 20 },
    maxOutputTokens: 300,
  }
}

describe('ai()', () => {
  afterEach(() => {
    vi.resetAllMocks()
    vi.unstubAllGlobals()
    try {
      window.localStorage.removeItem('bh-ai-prefer-server')
    } catch {
      // jsdom/happy-dom always has localStorage; ignore in case it doesn't
    }
  })

  it('throws AIUnavailableError("error") for an unknown task', async () => {
    vi.mocked(getTask).mockReturnValue(null)
    await expect(ai('nonexistent', {})).rejects.toMatchObject({ reason: 'error' })
    await expect(ai('nonexistent', {})).rejects.toBeInstanceOf(AIUnavailableError)
  })

  it('throws AIUnavailableError("error") when input fails the task schema', async () => {
    vi.mocked(getTask).mockReturnValue(fakeTask() as never)
    await expect(ai('ping', { bad: 'shape' })).rejects.toMatchObject({ reason: 'error' })
  })

  it('server-only tasks always go straight to the server, never local', async () => {
    vi.mocked(getTask).mockReturnValue(fakeTask({ tier: 'server-only' }) as never)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ output: { pong: true }, cached: false }),
      }),
    )

    const result = await ai('ping', {})

    expect(result).toEqual({ output: { pong: true }, via: 'server', cached: false })
    expect(promptLocal).not.toHaveBeenCalled()
  })

  it('local-first tasks use promptLocal when the prompt capability is available', async () => {
    vi.mocked(getTask).mockReturnValue(fakeTask({ tier: 'local-first' }) as never)
    vi.mocked(getAICapability).mockResolvedValue('available')
    vi.mocked(promptLocal).mockResolvedValue({ pong: true })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await ai('ping', {})

    expect(result).toEqual({ output: { pong: true }, via: 'local' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to the server when local execution fails', async () => {
    vi.mocked(getTask).mockReturnValue(fakeTask({ tier: 'local-first' }) as never)
    vi.mocked(getAICapability).mockResolvedValue('available')
    vi.mocked(promptLocal).mockRejectedValue(new Error('local failed'))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ output: { pong: true }, cached: false }),
      }),
    )

    const result = await ai('ping', {})
    expect(result).toEqual({ output: { pong: true }, via: 'server', cached: false })
  })

  it('opts.forceServer skips the local tier even when available', async () => {
    vi.mocked(getTask).mockReturnValue(fakeTask({ tier: 'local-first' }) as never)
    vi.mocked(getAICapability).mockResolvedValue('available')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ output: { pong: true }, cached: false }),
      }),
    )

    await ai('ping', {}, { forceServer: true })
    expect(promptLocal).not.toHaveBeenCalled()
  })

  it.each([
    ['ai_disabled', 503, 'disabled'],
    ['ai_unconfigured', 503, 'disabled'],
    ['plan', 429, 'plan'],
    ['budget', 429, 'budget'],
    ['ai_parse_failed', 502, 'error'],
  ] as const)('maps server error %s (%i) to reason %s', async (errorCode, status, reason) => {
    vi.mocked(getTask).mockReturnValue(fakeTask({ tier: 'server-only' }) as never)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ error: errorCode }),
      }),
    )

    await expect(ai('ping', {})).rejects.toMatchObject({ reason })
  })

  it('wraps a network failure as AIUnavailableError("error")', async () => {
    vi.mocked(getTask).mockReturnValue(fakeTask({ tier: 'server-only' }) as never)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    await expect(ai('ping', {})).rejects.toMatchObject({ reason: 'error' })
  })
})
