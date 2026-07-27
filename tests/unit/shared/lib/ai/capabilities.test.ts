import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAICapability, resetCapabilityCache } from '~/shared/lib/ai/capabilities'

describe('getAICapability', () => {
  afterEach(() => {
    resetCapabilityCache()
    // @ts-expect-error - test cleanup of a global we may have added
    delete globalThis.LanguageModel
    // @ts-expect-error - test cleanup of a global we may have added
    delete globalThis.Writer
  })

  it('returns "unavailable" when the Chrome API global does not exist', async () => {
    const status = await getAICapability('prompt')
    expect(status).toBe('unavailable')
  })

  it('returns the normalized availability from the matching global', async () => {
    // @ts-expect-error - minimal test double for the Chrome LanguageModel global
    globalThis.LanguageModel = { availability: vi.fn().mockResolvedValue('downloadable') }
    const status = await getAICapability('prompt')
    expect(status).toBe('downloadable')
  })

  it('memoizes the result per API — the underlying availability() is called once', async () => {
    const availability = vi.fn().mockResolvedValue('available')
    // @ts-expect-error - minimal test double
    globalThis.Writer = { availability }

    await getAICapability('writer')
    await getAICapability('writer')
    await getAICapability('writer')

    expect(availability).toHaveBeenCalledTimes(1)
  })

  it('resetCapabilityCache() clears the memoized result', async () => {
    const availability = vi.fn().mockResolvedValue('available')
    // @ts-expect-error - minimal test double
    globalThis.Writer = { availability }

    await getAICapability('writer')
    resetCapabilityCache()
    await getAICapability('writer')

    expect(availability).toHaveBeenCalledTimes(2)
  })

  it('normalizes an unrecognized availability string to "unavailable"', async () => {
    // @ts-expect-error - minimal test double
    globalThis.LanguageModel = { availability: vi.fn().mockResolvedValue('something-unexpected') }
    const status = await getAICapability('prompt')
    expect(status).toBe('unavailable')
  })

  it('falls back to "unavailable" when availability() throws', async () => {
    // @ts-expect-error - minimal test double
    globalThis.LanguageModel = { availability: vi.fn().mockRejectedValue(new Error('boom')) }
    const status = await getAICapability('prompt')
    expect(status).toBe('unavailable')
  })
})
