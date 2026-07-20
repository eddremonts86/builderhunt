import { createFileRoute } from '@tanstack/react-router'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { listOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'

export const Route = createFileRoute('/api/export/builders')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const builders = await withTenantContext(principal, (tx) =>
            listOrganizationBuilders(tx, principal.organizationId),
          )
          const header = ['username', 'source', 'score', 'language', 'country', 'topics', 'profileUrl']
          const rows = builders.map((builder) => [
            builder.username,
            builder.source,
            typeof builder.privateMetadata.score === 'number' ? builder.privateMetadata.score : 0,
            privateString(builder.privateMetadata.language) ?? builder.language ?? '',
            privateString(builder.privateMetadata.country) ?? builder.country ?? '',
            privateTopics(builder.privateMetadata).join('; '),
            builder.profileUrl,
          ])
          const csv = [
            header.join(','),
            ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
          ].join('\n')
          return new Response(csv, {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': 'attachment; filename="builders.csv"',
            },
          })
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Export error:', error)
          return Response.json({ error: 'Export failed' }, { status: 500 })
        }
      },
    },
  },
})

function privateString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function privateTopics(metadata: Record<string, unknown>) {
  return Array.isArray(metadata.topics)
    ? metadata.topics.filter((value): value is string => typeof value === 'string')
    : []
}
