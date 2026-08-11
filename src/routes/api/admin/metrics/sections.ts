/**
 * One validated section of the Admin Metrics page (plan 57, Admin track — "Split the monolithic Admin
 * Metrics API").
 *
 * ## Why one route with a validated `section` rather than eight files
 *
 * The eight sections return the same envelope — status, window, values, optional series and ranking — and
 * differ only in which keys they fill. Eight routes would be eight copies of the same platform-admin
 * guard, the same error mapping and the same parse, and the drift between them would be silent: a section
 * whose route forgot `requirePlatformAdminPrincipal` looks exactly like one that has it until somebody
 * calls it. `parseSectionRequest` is the single validator, and there is one guard.
 *
 * `overview.ts` is separate for a reason that is not symmetry: it is the section the page loads first and
 * re-reads on a sixty-second timer, so it is the one whose cost has to stay bounded and visible. A
 * reviewer looking at the frequent path should not have to read a switch to find out what it does.
 *
 * ## What a failure does here
 *
 * Nothing outside its own section. `buildSection` returns `unavailable` for a missing source rather than
 * throwing, and anything genuinely unexpected becomes `unavailable: 'error'` for the requested section —
 * a 200 carrying an honest "this one is broken", not a 500 that takes the page's other seven with it.
 * That is the property the split exists for, and the monolith could not have it: one failed read there
 * meant no numbers at all.
 *
 * A 400 is still a 400. An unknown section, range or variant is a caller mistake, and answering it with
 * an `unavailable` envelope would tell a typo it was a service outage.
 */
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { ADMIN_METRICS_SCHEMA_VERSION, parseSectionRequest } from '~/shared/lib/admin-metrics/contracts'
import { buildSection } from '~/shared/lib/admin-metrics/sections'

export const Route = createFileRoute('/api/admin/metrics/sections')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          const url = new URL(request.url)
          const parsed = parseSectionRequest({
            section: url.searchParams.get('section'),
            range: url.searchParams.get('range'),
            variant: url.searchParams.get('variant'),
          })
          if (!parsed.ok) {
            return Response.json({ error: 'invalid_request', detail: parsed.error }, { status: 400 })
          }

          /**
           * The per-section catch, which is the whole point of the route.
           *
           * `buildSection` already answers `unavailable` for a source that is absent by design. This
           * catches the other kind — a query that threw — and confines it to the section that asked,
           * because the page fetches sections independently and one broken aggregate must not blank the
           * seven that work.
           */
          let payload
          try {
            payload = await buildSection({
              section: parsed.section,
              range: parsed.range,
              variant: parsed.variant,
            })
          } catch (sectionError) {
            console.error(`admin metrics section "${parsed.section}" failed:`, sectionError)
            payload = { status: 'unavailable' as const, code: 'error' as const }
          }

          return Response.json({
            schemaVersion: ADMIN_METRICS_SCHEMA_VERSION,
            section: parsed.section,
            variant: parsed.variant,
            payload,
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin metrics sections error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
