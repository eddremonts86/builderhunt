/**
 * React hook combining Chrome on-device AI capability state with the public
 * `/api/ai/config` kill-switch surface. Feature components use this to
 * decide whether to render `<AIDownloadPrompt>` and whether to show AI UI
 * at all.
 */
import * as React from 'react'
import { getAICapability, resetCapabilityCache, type AICapabilityStatus } from './capabilities'

interface AIConfigResponse {
  disabled: boolean
  disabledTasks: string[]
  serverAI: boolean
}

const CONFIG_STALE_MS = 60_000

let cachedConfig: AIConfigResponse | null = null
let cachedConfigAt = 0
let inFlightConfigFetch: Promise<AIConfigResponse | null> | null = null

async function fetchConfig(): Promise<AIConfigResponse | null> {
  const now = Date.now()
  if (cachedConfig && now - cachedConfigAt < CONFIG_STALE_MS) return cachedConfig
  if (inFlightConfigFetch !== null) return inFlightConfigFetch

  inFlightConfigFetch = fetch('/api/ai/config')
    .then((response) => (response.ok ? (response.json() as Promise<AIConfigResponse>) : null))
    .then((config) => {
      if (config) {
        cachedConfig = config
        cachedConfigAt = Date.now()
      }
      return config
    })
    .catch(() => null)
    .finally(() => {
      inFlightConfigFetch = null
    })

  return inFlightConfigFetch
}

interface DownloadMonitor {
  addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void
}

interface LanguageModelDownloadConstructor {
  create(options: {
    monitor?: (monitor: DownloadMonitor) => void
  }): Promise<{ destroy(): void }>
}

function getLanguageModel(): LanguageModelDownloadConstructor | null {
  if (typeof window === 'undefined') return null
  const ctor = (globalThis as unknown as { LanguageModel?: LanguageModelDownloadConstructor }).LanguageModel
  return ctor ?? null
}

export interface UseAICapabilitiesResult {
  status: AICapabilityStatus
  ready: boolean
  needsDownload: boolean
  downloading: boolean
  downloadProgress: number
  requestDownload: () => Promise<void>
  serverAI: boolean
  disabled: boolean
}

export function useAICapabilities(): UseAICapabilitiesResult {
  const [status, setStatus] = React.useState<AICapabilityStatus>('unavailable')
  const [downloading, setDownloading] = React.useState(false)
  const [downloadProgress, setDownloadProgress] = React.useState(0)
  const [serverAI, setServerAI] = React.useState(false)
  const [disabled, setDisabled] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false

    getAICapability('prompt').then((result) => {
      if (!cancelled) setStatus(result)
    })

    fetchConfig().then((config) => {
      if (cancelled || !config) return
      setServerAI(config.serverAI)
      setDisabled(config.disabled)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const requestDownload = React.useCallback(async () => {
    const LanguageModel = getLanguageModel()
    if (!LanguageModel) return

    setDownloading(true)
    setDownloadProgress(0)
    try {
      const session = await LanguageModel.create({
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            setDownloadProgress(event.loaded)
          })
        },
      })
      session.destroy()
      resetCapabilityCache()
      const result = await getAICapability('prompt')
      setStatus(result)
    } finally {
      setDownloading(false)
    }
  }, [])

  return {
    status,
    ready: status === 'available',
    needsDownload: status === 'downloadable',
    downloading: downloading || status === 'downloading',
    downloadProgress,
    requestDownload,
    serverAI,
    disabled,
  }
}
