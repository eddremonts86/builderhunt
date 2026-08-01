/**
 * Turning a verified controller group into one canonical human.
 *
 * `verifyReciprocity` establishes that a set of accounts share a controller: each one declared a domain, and
 * the domain linked back to each one. This module is what records that as identity — and it does so by
 * handing `decideLink` an `explicit_cross_link` signal, which is a method it already auto-approves.
 *
 * **Nothing here decides anything.** `decideLink` stays the only decision point and is untouched, the
 * `human_source_links_probabilistic_needs_review_check` constraint stays the backstop, and a one-directional
 * declaration never reaches this module at all — it is still `declared` or `contradicted`, and the review
 * queue is where it belongs.
 *
 * ## Joining an existing human rather than making a new one
 *
 * The order matters. If any account in the group already belongs to a canonical human, the whole group joins
 * *that* human. Creating a second one and merging later would work, but it would mint a canonical human per
 * verification run and leave the merge history full of entries that record nothing but this function's
 * ignorance.
 *
 * When two accounts in one group already belong to two *different* humans, that is a genuine merge decision
 * with consequences for tenant data, and this module refuses it: the group is reported as
 * `needsMergeReview` and left alone. `mergeCanonicalHumans` exists for that, it captures a restore snapshot
 * before mutating, and an operator should be the one to invoke it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '~/shared/lib/db/client'
import { platformDb } from '~/shared/lib/db/platform-db'
import { findCanonicalHumanForAccount, linkSourceAccount } from '~/shared/lib/repositories/human-profiles'
import { log } from '~/shared/lib/log'

export interface ControllerGroup {
  /** The domain that proved the group shares a controller. Cited as the evidence. */
  domain: string
  builderIdentityIds: string[]
}

export interface UnifyResult {
  /** Groups where every account is now attached to one canonical human. */
  unified: Array<{ domain: string; canonicalHumanId: string; accountCount: number }>
  /** Groups spanning two or more existing canonical humans. Left untouched — merging is an operator act. */
  needsMergeReview: Array<{ domain: string; canonicalHumanIds: string[] }>
  /** Groups with only one account. Verified, recorded, but nothing to unify with yet. */
  singletons: number
}

export interface UnifyOptions {
  readDb?: PostgresJsDatabase
  /**
   * Writes go through the platform role.
   *
   * Migration 0122 gives the app role SELECT only on `human_source_links` — deliberately, so nothing on a
   * request path can assert that two people are the same person. Asserting identity is never a
   * request-scoped action, and this is the same reason `/api/admin/human-links` routes its verdict through
   * `platformDb`.
   */
  writeDb?: PostgresJsDatabase
  now?: Date
}

export async function unifyControllerGroups(
  groups: readonly ControllerGroup[],
  options: UnifyOptions = {},
): Promise<UnifyResult> {
  const readDb = options.readDb ?? publicDb
  const writeDb = options.writeDb ?? platformDb
  const now = options.now ?? new Date()
  const result: UnifyResult = { unified: [], needsMergeReview: [], singletons: 0 }

  for (const group of groups) {
    const accountIds = [...new Set(group.builderIdentityIds)]
    if (accountIds.length === 0) continue
    if (accountIds.length === 1) {
      // One account and a verified site is a real fact worth having recorded on the declaration, but there is
      // no second account to unify it with. Creating a canonical human for a single account would be
      // bookkeeping, not identity — it becomes worth doing the moment a second account anchors on the domain.
      result.singletons += 1
      continue
    }

    const existing = new Set<string>()
    for (const accountId of accountIds) {
      const human = await findCanonicalHumanForAccount(accountId, readDb)
      if (human) existing.add(human.id)
    }

    if (existing.size > 1) {
      // Two people the product already treats as separate, now evidenced as one. That is a merge, it has
      // consequences for tenant-private data pointing at either, and it is reversible only because
      // `mergeCanonicalHumans` captures a restore snapshot first. Not something a verification run does on
      // its own.
      result.needsMergeReview.push({ domain: group.domain, canonicalHumanIds: [...existing].sort() })
      log.info('identity_unify_needs_merge_review', {
        domain: group.domain, canonicalHumanIds: [...existing].sort(), accountCount: accountIds.length,
      })
      continue
    }

    const canonicalHumanId = [...existing][0]
    let targetId = canonicalHumanId
    for (const accountId of accountIds) {
      const linked = await linkSourceAccount({
        builderIdentityId: accountId,
        // The first account creates the human when none existed; every later one joins it. `declaredUrl` is
        // the domain, so the row records *what* proved the link rather than only that something did.
        canonicalHumanId: targetId,
        signal: {
          kind: 'explicit_cross_link',
          fromBuilderIdentityId: accountId,
          declaredUrl: `https://${group.domain}`,
          // Bidirectional: the account declared the domain and the domain linked back. That is the 9500-bps
          // case in `decideLink`, and it is the whole reason this is not a probabilistic guess.
          bidirectional: true,
        },
        observedAt: now,
      }, writeDb)
      targetId = linked.canonicalHumanId
    }

    result.unified.push({ domain: group.domain, canonicalHumanId: targetId!, accountCount: accountIds.length })
  }

  log.info('identity_unify_run', {
    unified: result.unified.length,
    accountsUnified: result.unified.reduce((sum, entry) => sum + entry.accountCount, 0),
    needsMergeReview: result.needsMergeReview.length,
    singletons: result.singletons,
  })
  return result
}
