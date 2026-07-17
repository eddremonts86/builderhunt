import { Home } from 'lucide-react'
import { LinkButton } from '~/components/ui'

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
      <h1 className="text-7xl font-bold tracking-tighter text-bh-text">404</h1>
      <h2 className="text-2xl font-semibold text-bh-text-muted mt-2">Page not found</h2>
      <p className="text-bh-text-muted/80 mt-2 max-w-md">Sorry, we couldn&apos;t find the page you&apos;re looking for.</p>
      <LinkButton to="/" variant="primary" className="mt-6">
        <Home className="mr-2 h-4 w-4" />
        Back to Home
      </LinkButton>
    </div>
  )
}