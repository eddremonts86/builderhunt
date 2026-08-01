/**
 * Verifies declared cross-links and unifies the accounts that prove one controller
 * (`pnpm identity:verify`).
 *
 * Safe to re-run: only `declared` rows are checked, so a domain already answered is not re-fetched. A run is
 * bounded by `--domains` (default 25) and fetches each domain's homepage once, honouring robots.
 *
 * `--dry-run` verifies and records the declaration states without creating or joining any canonical human,
 * which is the right way to look at what a first run would do before it does it.
 */
import { verifyReciprocity } from '~/lib/identity/reciprocity'
import { unifyControllerGroups } from '~/lib/identity/unify'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const domainArg = args.find((arg) => arg.startsWith('--domains='))
const domainLimit = domainArg ? Number(domainArg.split('=')[1]) : 25
if (!Number.isFinite(domainLimit) || domainLimit <= 0) {
  console.error('Usage: pnpm identity:verify [--domains=N] [--dry-run]')
  process.exit(1)
}

const verification = await verifyReciprocity({ domainLimit })
console.log(JSON.stringify({ verification: { ...verification, controllerGroups: verification.controllerGroups.length } }))
for (const group of verification.controllerGroups) {
  console.log(`  ${group.domain}: ${group.builderIdentityIds.length} account(s)`)
}

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, wouldUnify: verification.controllerGroups.filter((g) => g.builderIdentityIds.length > 1).length }))
  process.exit(0)
}

const unified = await unifyControllerGroups(verification.controllerGroups)
console.log(JSON.stringify({ unified: unified.unified, needsMergeReview: unified.needsMergeReview, singletons: unified.singletons }))
process.exit(0)
