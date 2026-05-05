import * as React from 'react'
import { Download } from 'lucide-react'

export function ExportsPage() {
  const [loading, setLoading] = React.useState(false)
  const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleDownload = async () => {
    setLoading(true)
    setMessage(null)
    try {
      const res = await fetch('/api/export/builders', { credentials: 'include' })
      if (!res.ok) {
        setMessage({ type: 'error', text: 'Please sign in to download your builders.' })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'builders.csv'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setMessage({ type: 'error', text: 'Download failed. Please try again.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold text-bh-text mb-1">Exports</h1>
      <p className="text-bh-text-muted mb-8">Download your builder lists</p>

      <div className="card max-w-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 rounded-xl bg-bh-accent/10">
            <Download className="w-6 h-6 text-bh-accent" />
          </div>
          <div>
            <p className="font-medium text-bh-text">Export all builders</p>
            <p className="text-sm text-bh-text-muted">Download as CSV</p>
          </div>
        </div>

        {message && (
          <p className={`text-sm mb-4 ${message.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
            {message.text}
          </p>
        )}

        <button
          onClick={handleDownload}
          disabled={loading}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Download className="w-4 h-4" />
          {loading ? 'Preparing...' : 'Download CSV'}
        </button>
      </div>
    </div>
  )
}
