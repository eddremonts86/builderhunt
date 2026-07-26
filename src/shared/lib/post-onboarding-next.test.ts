import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import { consumePostOnboardingNext, POST_ONBOARDING_NEXT_KEY } from './post-onboarding-next'

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  clear() { this.store.clear() }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null }
  removeItem(key: string) { this.store.delete(key) }
  setItem(key: string, value: string) { this.store.set(key, value) }
}

beforeAll(() => {
  if (!window.sessionStorage) {
    Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage(), configurable: true })
  }
})

afterEach(() => window.sessionStorage.clear())

describe('consumePostOnboardingNext', () => {
  it('returns null when nothing is stashed', () => {
    expect(consumePostOnboardingNext()).toBeNull()
  })

  it('returns and clears a stashed value (one-shot)', () => {
    window.sessionStorage.setItem(POST_ONBOARDING_NEXT_KEY, '/search?q=rust')
    expect(consumePostOnboardingNext()).toBe('/search?q=rust')
    expect(consumePostOnboardingNext()).toBeNull()
  })
})
