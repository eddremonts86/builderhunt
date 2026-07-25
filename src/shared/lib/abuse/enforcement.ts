import { env } from '../env'
import { getAccountRisk, withWorkerUser } from '../repositories/account-risk'

/**
 * `resolveEnforcement()` — abuse-and-usage-integrity plan, Phase 5. The single policy mapping a
 * user's current risk state + the global `ABUSE_ENFORCEMENT_MODE` kill-switch to an ACTUAL
 * enforcement stage. `abuse/risk.ts`'s `computeCandidateRiskStage` already computes the candidate
 * stage from decayed signals (with its own corroboration cap); this module is the second, separate
 * gate — the same "detect unconditionally, gate the consequence by mode" idiom used by every other
 * check in this plan (G2/G4/G6's `enforce`-only blocking checks). `mode` is the deploy-wide dial:
 * - `observe`: always `'observe'`, whatever the candidate stage — matches this plan's own
 *   fail-open invariant (unset/default config never changes behavior).
 * - `warn`: caps the effective stage at `'warned'` — the ladder can surface a banner, never
 *   step-up/throttle/block. This is the first place `warn` is distinguished from `observe`
 *   anywhere in this codebase (every other gate today only branches on `=== 'enforce'`).
 * - `enforce`: the candidate stage passes through unchanged — the full ladder is live.
 */

export type EnforcementStage = 'observe' | 'warned' | 'stepup' | 'throttled' | 'blocked'

const STAGE_ORDER: readonly EnforcementStage[] = ['observe', 'warned', 'stepup', 'throttled', 'blocked']

function isEnforcementStage(value: unknown): value is EnforcementStage {
  return typeof value === 'string' && (STAGE_ORDER as readonly string[]).includes(value)
}

export interface EnforcementDecision {
  /** The stage actually in effect — what callers should act on. */
  stage: EnforcementStage
  /** What the risk signals alone would justify, before the mode cap — kept for audit/debugging, never acted on directly. */
  candidateStage: EnforcementStage
  mode: typeof env.ABUSE_ENFORCEMENT_MODE
}

/** Pure policy: mode + candidate stage → effective stage. */
export function resolveEnforcement(
  mode: typeof env.ABUSE_ENFORCEMENT_MODE,
  candidateStage: EnforcementStage,
): EnforcementDecision {
  if (mode === 'observe') return { stage: 'observe', candidateStage, mode }
  if (mode === 'warn') {
    const cappedIndex = Math.min(STAGE_ORDER.indexOf(candidateStage), STAGE_ORDER.indexOf('warned'))
    return { stage: STAGE_ORDER[cappedIndex], candidateStage, mode }
  }
  return { stage: candidateStage, candidateStage, mode }
}

export interface ResolveEnforcementForUserDeps {
  mode?: typeof env.ABUSE_ENFORCEMENT_MODE
  getAccountRisk?: typeof getAccountRisk
  withWorkerUser?: typeof withWorkerUser
}

/**
 * The request-facing entry point (matches `spec.md`'s own `resolveEnforcement(userId)` signature).
 * Reads the already-persisted `account_risk.stage` (`getAccountRisk` — a plain indexed SELECT, no
 * recomputation) rather than rescoring signals on every call; a user with no `account_risk` row
 * yet (never triggered a signal) is treated as `'observe'`.
 *
 * Short-circuits before touching the database at all when `mode === 'observe'` (the default) —
 * `resolveEnforcement('observe', anything)` always returns `'observe'` regardless of the
 * candidate stage, so the query result can never matter in that mode. This is what makes it safe
 * to call from a hot request path: in the default configuration it costs nothing beyond a plain
 * object allocation; the worker-role read only happens once an operator has deliberately opted
 * into `warn`/`enforce`.
 */
export async function resolveEnforcementForUser(
  userId: string,
  deps: ResolveEnforcementForUserDeps = {},
): Promise<EnforcementDecision> {
  const mode = deps.mode ?? env.ABUSE_ENFORCEMENT_MODE
  if (mode === 'observe') return resolveEnforcement(mode, 'observe')

  const runWithWorkerUser = deps.withWorkerUser ?? withWorkerUser
  const readAccountRisk = deps.getAccountRisk ?? getAccountRisk
  const risk = await runWithWorkerUser(userId, (transaction) => readAccountRisk(transaction, userId))
  const candidateStage = isEnforcementStage(risk?.stage) ? risk.stage : 'observe'
  return resolveEnforcement(mode, candidateStage)
}
