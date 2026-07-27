import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { promptLocal } from '~/shared/lib/ai/local'
import { AIParseError } from '~/shared/lib/ai/errors'

const schema = z.object({ pong: z.literal(true) })

describe('promptLocal', () => {
  afterEach(() => {
    // @ts-expect-error - test cleanup of a global we may have added
    delete globalThis.LanguageModel
  })

  it('throws AIParseError when Chrome LanguageModel is unavailable', async () => {
    await expect(promptLocal({ system: 'sys', prompt: 'p', schema })).rejects.toBeInstanceOf(AIParseError)
  })

  it('returns the parsed output on a valid first response and destroys the session', async () => {
    const destroy = vi.fn()
    const prompt = vi.fn().mockResolvedValue('{"pong": true}')
    // @ts-expect-error - minimal test double for the Chrome LanguageModel global
    globalThis.LanguageModel = { create: vi.fn().mockResolvedValue({ prompt, destroy }) }

    const result = await promptLocal({ system: 'sys', prompt: 'p', schema })

    expect(result).toEqual({ pong: true })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('retries once with a correction prompt on a schema-invalid first response', async () => {
    const destroy = vi.fn()
    const prompt = vi.fn().mockResolvedValueOnce('{"pong": false}').mockResolvedValueOnce('{"pong": true}')
    // @ts-expect-error - minimal test double
    globalThis.LanguageModel = { create: vi.fn().mockResolvedValue({ prompt, destroy }) }

    const result = await promptLocal({ system: 'sys', prompt: 'p', schema })

    expect(result).toEqual({ pong: true })
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('throws AIParseError after two schema-invalid responses, still destroying the session', async () => {
    const destroy = vi.fn()
    const prompt = vi.fn().mockResolvedValue('not json at all')
    // @ts-expect-error - minimal test double
    globalThis.LanguageModel = { create: vi.fn().mockResolvedValue({ prompt, destroy }) }

    await expect(promptLocal({ system: 'sys', prompt: 'p', schema })).rejects.toBeInstanceOf(AIParseError)
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})
