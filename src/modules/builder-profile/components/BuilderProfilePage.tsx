import * as React from 'react'
import { useParams, Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Code } from 'lucide-react'

export function BuilderProfilePage() {
  const { builderId } = useParams()
  const [builder, setBuilder] = React.useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (!builderId) return
    // TODO: fetch from API
    setLoading(false)
  }, [builderId])

  if (loading) {
    return (
      <div className="p-8">
        <p className="text-bh-text-muted">Loading...</p>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link
        to="/_dashboard/search/"
        className="flex items-center gap-2 text-bh-text-muted hover:text-bh-text text-sm mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to search
      </Link>

      {builder ? (
        <div className="card">
          <p className="text-bh-text-muted">Builder profile: {builderId}</p>
        </div>
      ) : (
        <div className="card">
          <p className="text-bh-text-muted">Builder not found</p>
        </div>
      )}
    </div>
  )
}