import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { SOURCE_NAMES, type SourceName } from '~/lib/sources/types'
import { SOURCE_PRESENTATION } from '~/shared/lib/source-presentation'
import { AI_TASKS, isTaskDisabled } from '~/shared/lib/ai/tasks'
import { env } from '~/shared/lib/env'
import { metrics } from '~/shared/lib/metrics'
import { getDiscoveryState } from '~/shared/lib/repositories/discovery-state'

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

/** Env var(s) whose presence means this source's connector can authenticate. Absent from this map = no credential is required (a public, keyless API, or — `devpost` — a headless-browser worker). */
const CREDENTIAL_ENV_VARS: Partial<Record<SourceName, Array<keyof typeof env>>> = {
  github: ['GITHUB_TOKEN'],
  gitlab: ['GITLAB_TOKEN'],
  codeberg: ['CODEBERG_TOKEN'],
  sourcehut: ['SOURCEHUT_TOKEN'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  hashnode: ['HASHNODE_API_KEY'],
  stackoverflow: ['STACKOVERFLOW_API_KEY'],
  huggingface: ['HUGGINGFACE_TOKEN'],
  producthunt: ['PRODUCTHUNT_TOKEN'],
}

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

          const sources = SOURCE_NAMES.map((source) => {
            const presentation = SOURCE_PRESENTATION[source]
            const requiredVars = CREDENTIAL_ENV_VARS[source] ?? []
            const killSwitchVar = KILL_SWITCH_ENV_VARS[source]
            return {
              source,
              label: presentation.label,
              trackable: presentation.trackable,
              dormantReason: presentation.dormantReason,
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
