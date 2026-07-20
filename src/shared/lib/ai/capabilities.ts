/**
 * Chrome built-in AI (Gemini Nano) capability detection.
 *
 * Feature-detects the experimental `LanguageModel` / `Writer` / `Rewriter` /
 * `Summarizer` globals (Chrome Prompt/Writer/Rewriter/Summarizer APIs — see
 * https://developer.chrome.com/docs/ai/prompt-api). SSR-safe: always
 * `'unavailable'` when `window` doesn't exist. Results are memoized per API
 * for the lifetime of the page (`resetCapabilityCache()` clears this, used
 * by tests and after a model download completes).
 */

export type AICapabilityStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable'
export type AICapabilityApi = 'prompt' | 'writer' | 'rewriter' | 'summarizer'

interface ChromeAICapabilityConstructor {
  availability(): Promise<string>
}

const GLOBAL_NAMES: Record<AICapabilityApi, string> = {
  prompt: 'LanguageModel',
  writer: 'Writer',
  rewriter: 'Rewriter',
  summarizer: 'Summarizer',
}

const capabilityCache = new Map<AICapabilityApi, AICapabilityStatus>()

function normalizeAvailability(raw: string): AICapabilityStatus {
  return raw === 'available' || raw === 'downloadable' || raw === 'downloading' ? raw : 'unavailable'
}

/** Clears the memoized capability results. Call after a model finishes downloading, or between tests. */
export function resetCapabilityCache(): void {
  capabilityCache.clear()
}

export async function getAICapability(api: AICapabilityApi): Promise<AICapabilityStatus> {
  if (typeof window === 'undefined') return 'unavailable'

  const cached = capabilityCache.get(api)
  if (cached) return cached

  const globalName = GLOBAL_NAMES[api]
  if (!(globalName in globalThis)) {
    capabilityCache.set(api, 'unavailable')
    return 'unavailable'
  }

  try {
    const ctor = (globalThis as unknown as Record<string, ChromeAICapabilityConstructor>)[globalName]
    const raw = await ctor.availability()
    const status = normalizeAvailability(raw)
    capabilityCache.set(api, status)
    return status
  } catch {
    capabilityCache.set(api, 'unavailable')
    return 'unavailable'
  }
}
