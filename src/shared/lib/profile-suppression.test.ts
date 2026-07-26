import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listActiveSuppressionsMock = vi.fn()

vi.mock('./repositories/profile-removal', () => ({
  listActiveSuppressions: (...args: unknown[]) => listActiveSuppressionsMock(...args),
}))

describe('profile-suppression', () => {
  beforeEach(() => {
    vi.resetModules()
    listActiveSuppressionsMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('filters out items matching an active suppression', async () => {
    listActiveSuppressionsMock.mockResolvedValue([{ source: 'github', sourceId: '123' }])
    const { filterSuppressed } = await import('./profile-suppression')
    const items = [
      { source: 'github', sourceId: '123', name: 'suppressed' },
      { source: 'github', sourceId: '456', name: 'kept' },
    ]
    const result = await filterSuppressed(items)
    expect(result).toEqual([{ source: 'github', sourceId: '456', name: 'kept' }])
  })

  it('is a no-op when there are no active suppressions', async () => {
    listActiveSuppressionsMock.mockResolvedValue([])
    const { filterSuppressed } = await import('./profile-suppression')
    const items = [{ source: 'github', sourceId: '1' }]
    const result = await filterSuppressed(items)
    expect(result).toEqual(items)
  })

  it('caches the active-suppression set across calls within the TTL (one DB read for two calls)', async () => {
    listActiveSuppressionsMock.mockResolvedValue([{ source: 'github', sourceId: '1' }])
    const { isSuppressed } = await import('./profile-suppression')
    await isSuppressed('github', '1')
    await isSuppressed('github', '2')
    expect(listActiveSuppressionsMock).toHaveBeenCalledTimes(1)
  })

  it('invalidateSuppressionCache forces the next read to hit the DB again', async () => {
    listActiveSuppressionsMock.mockResolvedValue([])
    const { isSuppressed, invalidateSuppressionCache } = await import('./profile-suppression')
    await isSuppressed('github', '1')
    invalidateSuppressionCache()
    await isSuppressed('github', '1')
    expect(listActiveSuppressionsMock).toHaveBeenCalledTimes(2)
  })

  it('isSuppressed reports true only for an exact (source, sourceId) match', async () => {
    listActiveSuppressionsMock.mockResolvedValue([{ source: 'github', sourceId: '1' }])
    const { isSuppressed } = await import('./profile-suppression')
    expect(await isSuppressed('github', '1')).toBe(true)
    expect(await isSuppressed('gitlab', '1')).toBe(false)
    expect(await isSuppressed('github', '2')).toBe(false)
  })
})
