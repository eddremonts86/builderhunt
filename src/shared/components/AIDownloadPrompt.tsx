/**
 * One-time inline prompt offering the Chrome on-device AI model download.
 * Feature components that use `ai()` for a `local-first` task render this
 * above their AI UI so users on Chrome get a chance to enable on-device
 * execution before falling back to the server.
 *
 * Renders `null` when the model is already `ready`, the AI platform is
 * `disabled` (kill switch), or the user already dismissed/opted out.
 */
import * as React from 'react'
import { Sparkles, X } from 'lucide-react'
import { useAICapabilities } from '~/shared/lib/ai/useAICapabilities'

const PREFER_SERVER_STORAGE_KEY = 'bh-ai-prefer-server'
const DISMISSED_STORAGE_KEY = 'bh-ai-download-dismissed'

function readLocalFlag(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeLocalFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1')
  } catch {
    // localStorage unavailable (private browsing, etc.) — degrade silently.
  }
}

export function AIDownloadPrompt() {
  const { ready, needsDownload, downloading, downloadProgress, requestDownload, disabled } = useAICapabilities()
  const [dismissed, setDismissed] = React.useState(() => readLocalFlag(DISMISSED_STORAGE_KEY))
  const [preferServer, setPreferServer] = React.useState(() => readLocalFlag(PREFER_SERVER_STORAGE_KEY))

  if (ready || disabled || dismissed || preferServer || (!needsDownload && !downloading)) return null

  const handleDismiss = () => {
    writeLocalFlag(DISMISSED_STORAGE_KEY)
    setDismissed(true)
  }

  const handleUseServerInstead = () => {
    writeLocalFlag(PREFER_SERVER_STORAGE_KEY)
    setPreferServer(true)
  }

  const progressPct = Math.round(downloadProgress * 100)

  const handleStartDownload = () => {
    requestDownload().catch(() => {
      // Download failures are surfaced via capability status staying
      // 'downloadable'; nothing else to do here.
    })
  }

  return (
    <div className="card p-4 flex items-start gap-3" data-testid="ai-download-prompt">
      <Sparkles className="w-4 h-4 text-bh-accent shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-bh-text">Enable on-device AI</p>
        <p className="text-xs text-bh-text-dim mt-0.5">
          One-time download runs this feature privately on your device — nothing leaves your browser.
        </p>

        {downloading ? (
          <div className="mt-3">
            <div className="h-1.5 w-full bg-bh-bg-alt rounded-full overflow-hidden">
              <div
                className="h-full bg-bh-accent rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-[11px] text-bh-text-dim mt-1">Downloading… {progressPct}%</p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              type="button"
              className="btn-primary btn-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              onClick={handleStartDownload}
              data-testid="ai-download-start"
            >
              Enable on-device AI
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              onClick={handleUseServerInstead}
              data-testid="ai-download-use-server"
            >
              Use server instead
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="text-bh-text-dim hover:text-bh-text shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded"
        aria-label="Dismiss"
        data-testid="ai-download-dismiss"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  )
}
