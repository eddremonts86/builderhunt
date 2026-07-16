// In-process metrics. Resets on server restart. Cheap and effective for
// bootstrap scale. Swap for a real metrics system when volume justifies.

interface Counters {
  searches: number
  searchCacheHits: number
  apiRequests: number
  apiErrors: number
  signups: number
  signins: number
}

const counters: Counters = {
  searches: 0,
  searchCacheHits: 0,
  apiRequests: 0,
  apiErrors: 0,
  signups: 0,
  signins: 0,
}

const startTime = Date.now()

export const metrics = {
  increment(name: keyof Counters, by = 1) {
    counters[name] += by
  },
  get(): Counters & { uptimeMs: number; uptimeSeconds: number } {
    return {
      ...counters,
      uptimeMs: Date.now() - startTime,
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    }
  },
  reset() {
    counters.searches = 0
    counters.searchCacheHits = 0
    counters.apiRequests = 0
    counters.apiErrors = 0
    counters.signups = 0
    counters.signins = 0
  },
}
