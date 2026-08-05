import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { SOURCE_NAMES, type SourceName } from '~/lib/sources/types'
import { SOURCE_PRESENTATION } from '~/shared/lib/source-presentation'
import { AI_TASKS, isTaskDisabled } from '~/shared/lib/ai/tasks'
import { env } from '~/shared/lib/env'
import { metrics } from '~/shared/lib/metrics'
import { getDiscoveryState } from '~/shared/lib/repositories/discovery-state'
import { listSearchSources } from '~/shared/lib/repositories/search-sources'
import { CREDENTIAL_ENV_VARS } from '~/shared/lib/source-credentials'

/**
 * Redacted integration and AI health API (plans/UI/tasks.md Wave 5 "Add a redacted integration and
 * AI health API"). Every `SourceName` and every registered AI task gets exactly one row — built by
 * iterating the existing exhaustive registries (`SOURCE_PRESENTATION: Record<SourceName, …>`,
 * `AI_TASKS`), so a source or task added later without a row here is a type error at its own
 * registry's definition site, not a silent gap in this projection.
 *
 * Never returns a credential value, a provider payload, a prompt, or user input — only booleans,
 * counts, and the small set of facts already true about the deployed build (source label, task
 * tier/version). Where no tracking exists yet (per-source quota, last success/failure, indexed or
 * backlog counts — see the research behind this task), the field is `null` rather than a fabricated
 * number; the honest gap is the correct value until that tracking is built.
 */

// Moved to `~/shared/lib/source-credentials` on 2026-08-05 so `~/lib/search` can read the same table
// and report a source `unconfigured` rather than contacting an upstream that is certain to refuse.
// Two copies of this map would drift, which is the same argument that put `search_sources` in the
// join below instead of a hand-mirrored registry.

/** Sources with their own dedicated kill switch. Absent = always on unless dormant (see `SOURCE_PRESENTATION[source].trackable`). */
const KILL_SWITCH_ENV_VARS: Partial<Record<SourceName, keyof typeof env>> = {
  devpost: 'DEVPOST_ENABLED',
}

export const Route = createFileRoute('/api/admin/integrations/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)

          /*
           * The database's own view of each source, joined in because this projection was wrong without it.
           *
           * `search_sources.enabled` / `connector_implemented` is the real kill switch: `sourcehut` and
           * `hashnode` were retired on 2026-08-04 (drizzle/0143, 0144), **their connector files were
           * deleted**, and both rows read `false, false`. This endpoint built its rows from
           * `SOURCE_PRESENTATION` alone — a compile-time registry that nobody updated — so
           * `/admin/integrations` showed both as **ACTIVE**, for sources whose code no longer exists.
           * Found 2026-08-05 when Edd read the page and it disagreed with reality.
           *
           * Joining the table rather than editing two entries in the registry is the point: a hand-patched
           * registry goes stale again at the next retirement, which is exactly how this happened.
           */
          const registered = new Map((await listSearchSources().catch(() => [])).map((row) => [row.key, row]))

          const sources = SOURCE_NAMES.map((source) => {
            const presentation = SOURCE_PRESENTATION[source]
            const requiredVars = CREDENTIAL_ENV_VARS[source] ?? []
            const killSwitchVar = KILL_SWITCH_ENV_VARS[source]
            const row = registered.get(source)
            // Absent from the table is not the same as disabled in it: a source with no row has never been
            // registered, and reporting that as "retired" would invent a decision nobody made.
            const registryEnabled = row ? row.enabled : null
            const connectorImplemented = row ? row.connectorImplemented : null
            const retired = row ? !row.enabled && !row.connectorImplemented : false
            return {
              source,
              label: presentation.label,
              // A retired source is not trackable whatever the compile-time registry still says.
              trackable: presentation.trackable && !retired,
              dormantReason: retired
                ? `Retired — the connector was removed and ${source === 'sourcehut' ? "sr.ht's robots policy excludes this use" : 'its API moved behind a paid plan'}`
                : presentation.dormantReason,
              registryEnabled,
              connectorImplemented,
              retired,
              credentialRequired: requiredVars.length > 0,
              credentialPresent: requiredVars.length === 0 || requiredVars.every((name) => Boolean(env[name])),
              killSwitchEnabled: killSwitchVar ? env[killSwitchVar] === 'true' : null,
              // Not tracked per source anywhere yet — honest gaps, not fabricated numbers.
              quota: null,
              lastSuccessAt: null,
              lastFailureAt: null,
              indexedCount: null,
              backlogCount: null,
            }
          })

          const aiTasks = (Object.keys(AI_TASKS) as Array<keyof typeof AI_TASKS>).map((taskId) => {
            const task = AI_TASKS[taskId]
            return {
              taskId,
              tier: task.tier,
              sensitive: task.sensitive ?? false,
              version: task.version ?? '1',
              disabled: isTaskDisabled(taskId, { AI_DISABLED: env.AI_DISABLED, AI_DISABLED_TASKS: env.AI_DISABLED_TASKS }),
            }
          })

          const discovery = await getDiscoveryState()

          return Response.json({
            sources,
            aiTasks,
            aiGloballyDisabled: env.AI_DISABLED === 'true',
            aiProviderAvailable: Boolean(env.MINIMAX_API_KEY),
            aiBudgetDenials: metrics.get().aiBudgetDenials,
            enrichmentEnabled: env.ENRICHMENT_ENABLED === 'true',
            // Cross-source aggregate only — proactive discovery has no per-`SourceName` breakdown
            // (see the research behind this task); reported as one global figure, not fabricated
            // per source.
            discovery: discovery ? { cursor: discovery.cursor, lastRunAt: discovery.lastRunAt?.toISOString() ?? null, stats: discovery.stats } : null,
            generatedAt: new Date().toISOString(),
          })
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin integrations projection error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
