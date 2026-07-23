/**
 * Provision (create-or-validate) the BuilderHunt Stripe billing catalog.
 *
 * Fulfils the plan task "Validate Stripe Products and Prices before mutation"
 * (plans/stripe-billing-platform/tasks.md §1): it fetches existing objects
 * read-only, compares amount / currency / interval / product / tax behavior /
 * livemode / archive state / metadata against src/shared/lib/billing/catalog.ts,
 * and REFUSES to mutate anything that already exists but diverges. It only
 * creates what is missing. It never invents a Price ID locally — the real IDs
 * come back from Stripe and (with --write) are pasted into the catalog.
 *
 * The single source of truth for amounts/intervals/credits is catalog.ts. This
 * script derives everything from it; do not hardcode prices here.
 *
 * Usage (run from repo root; needs a real Stripe secret key in env):
 *
 *   STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision            # create-or-validate (test)
 *   STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision --validate # read-only, never create
 *   STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision --write    # provision + patch catalog.ts
 *   STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision --dry-run  # print the plan, call nothing
 *
 * The test/live column patched by --write is chosen automatically from the key
 * prefix (sk_test_ -> "test", sk_live_ -> "live"). A live key is refused unless
 * you also pass --allow-live, so you can never accidentally mutate production.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Stripe from 'stripe'
import {
  SUBSCRIPTION_CATALOG,
  PACK_CATALOG,
  type SubscriptionCatalogEntry,
  type PackCatalogEntry,
} from '../../src/shared/lib/billing/catalog.ts'

// Pin to the exact version the installed SDK (stripe@22.3.2) ships, so the
// webhook endpoint, fixtures, and this provisioner all agree. This is also the
// value that must go in STRIPE_API_VERSION in .env.
const API_VERSION = '2026-06-24.dahlia' as Stripe.LatestApiVersion

// Stripe Tax product tax code for "Software as a service (SaaS) — business use".
// Confirm against your Stripe Tax settings; change here if your accountant
// prefers a different code, then re-run.
const TAX_CODE = 'txcd_10103000'

const STATEMENT_HINT = 'BuilderHunt' // informational only; statement descriptor is set at the account level

const __dirname = dirname(fileURLToPath(import.meta.url))
const CATALOG_PATH = resolve(__dirname, '../../src/shared/lib/billing/catalog.ts')

type Mode = 'provision' | 'validate' | 'dry-run'

interface Flags {
  mode: Mode
  write: boolean
  allowLive: boolean
}

function parseFlags(argv: string[]): Flags {
  const has = (f: string) => argv.includes(f)
  const mode: Mode = has('--validate') ? 'validate' : has('--dry-run') ? 'dry-run' : 'provision'
  return { mode, write: has('--write'), allowLive: has('--allow-live') }
}

// Deterministic product IDs → idempotent retrieve-or-create (Stripe accepts a
// custom `id` on product creation). One product per subscription tier (two
// prices hang off it), one product per credit pack.
const PRODUCT_IDS = {
  pro: 'bh_sub_pro',
  pro_max: 'bh_sub_pro_max',
  team: 'bh_sub_team',
} as const

const PRODUCT_NAMES = {
  pro: 'BuilderHunt Pro',
  pro_max: 'BuilderHunt Pro Max',
  team: 'BuilderHunt Team',
} as const

function packProductId(key: string): string {
  return `bh_pack_${key}`
}

function intervalOf(entry: SubscriptionCatalogEntry): 'month' | 'year' {
  return entry.interval === 'annual' ? 'year' : 'month'
}

class MismatchError extends Error {
  constructor(public key: string, public diffs: string[]) {
    super(`Existing Stripe object for "${key}" does not match catalog — refusing to mutate:\n  - ${diffs.join('\n  - ')}`)
    this.name = 'MismatchError'
  }
}

async function ensureProduct(
  stripe: Stripe,
  id: string,
  name: string,
  metadata: Record<string, string>,
  dryRun: boolean,
): Promise<string> {
  try {
    const existing = await stripe.products.retrieve(id)
    if (existing.tax_code !== TAX_CODE && !dryRun) {
      await stripe.products.update(id, { tax_code: TAX_CODE })
    }
    return existing.id
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') {
      if (dryRun) {
        console.log(`  [dry-run] would CREATE product ${id} (${name})`)
        return id
      }
      const created = await stripe.products.create({
        id,
        name,
        tax_code: TAX_CODE,
        statement_descriptor: STATEMENT_HINT.slice(0, 22),
        metadata,
      })
      console.log(`  created product ${created.id} (${name})`)
      return created.id
    }
    throw err
  }
}

/** Find an existing Price by lookup_key (no search-index lag). */
async function findPriceByLookupKey(stripe: Stripe, key: string): Promise<Stripe.Price | null> {
  const res = await stripe.prices.list({ lookup_keys: [key], limit: 1, expand: ['data.product'] })
  return res.data[0] ?? null
}

function validateSubscriptionPrice(entry: SubscriptionCatalogEntry, price: Stripe.Price, productId: string): string[] {
  const diffs: string[] = []
  if (price.unit_amount !== entry.amountCents) diffs.push(`unit_amount ${price.unit_amount} ≠ ${entry.amountCents}`)
  if (price.currency !== 'usd') diffs.push(`currency ${price.currency} ≠ usd`)
  if (price.tax_behavior !== 'exclusive') diffs.push(`tax_behavior ${price.tax_behavior} ≠ exclusive`)
  if (price.type !== 'recurring') diffs.push(`type ${price.type} ≠ recurring`)
  if (price.recurring?.interval !== intervalOf(entry)) diffs.push(`interval ${price.recurring?.interval} ≠ ${intervalOf(entry)}`)
  if ((price.recurring?.interval_count ?? 1) !== 1) diffs.push(`interval_count ${price.recurring?.interval_count} ≠ 1`)
  const prodId = typeof price.product === 'string' ? price.product : price.product?.id
  if (prodId !== productId) diffs.push(`product ${prodId} ≠ ${productId}`)
  if (!price.active) diffs.push('price is archived/inactive')
  return diffs
}

function validatePackPrice(entry: PackCatalogEntry, price: Stripe.Price, productId: string): string[] {
  const diffs: string[] = []
  if (price.unit_amount !== entry.amountCents) diffs.push(`unit_amount ${price.unit_amount} ≠ ${entry.amountCents}`)
  if (price.currency !== 'usd') diffs.push(`currency ${price.currency} ≠ usd`)
  if (price.tax_behavior !== 'exclusive') diffs.push(`tax_behavior ${price.tax_behavior} ≠ exclusive`)
  if (price.type !== 'one_time') diffs.push(`type ${price.type} ≠ one_time`)
  const prodId = typeof price.product === 'string' ? price.product : price.product?.id
  if (prodId !== productId) diffs.push(`product ${prodId} ≠ ${productId}`)
  if (!price.active) diffs.push('price is archived/inactive')
  return diffs
}

async function ensureSubscriptionPrice(
  stripe: Stripe,
  entry: SubscriptionCatalogEntry,
  flags: Flags,
): Promise<string> {
  const productId = PRODUCT_IDS[entry.tier]
  await ensureProduct(stripe, productId, PRODUCT_NAMES[entry.tier], { builderhunt_tier: entry.tier, kind: 'subscription' }, flags.mode === 'dry-run')

  const existing = await findPriceByLookupKey(stripe, entry.key)
  if (existing) {
    const diffs = validateSubscriptionPrice(entry, existing, productId)
    if (diffs.length) throw new MismatchError(entry.key, diffs)
    console.log(`  ok   ${entry.key.padEnd(16)} → ${existing.id} (validated, unchanged)`)
    return existing.id
  }
  if (flags.mode === 'validate') throw new MismatchError(entry.key, ['no Price exists with this lookup_key (validate mode will not create it)'])
  if (flags.mode === 'dry-run') {
    console.log(`  [dry-run] would CREATE price ${entry.key} = $${(entry.amountCents / 100).toFixed(2)}/${intervalOf(entry)}`)
    return `price_DRYRUN_${entry.key}`
  }
  const created = await stripe.prices.create(
    {
      currency: 'usd',
      unit_amount: entry.amountCents,
      tax_behavior: 'exclusive',
      lookup_key: entry.key,
      transfer_lookup_key: true,
      product: productId,
      recurring: { interval: intervalOf(entry), interval_count: 1 },
      metadata: {
        catalog_key: entry.key,
        catalog_version: String(entry.version),
        tier: entry.tier,
        interval: entry.interval,
        monthly_credits: String(entry.monthlyCredits),
        seat_limit: String(entry.seatLimit),
        kind: 'subscription',
      },
    },
    { idempotencyKey: `provision:price:${entry.key}:v${entry.version}` },
  )
  console.log(`  created ${entry.key.padEnd(16)} → ${created.id} = $${(entry.amountCents / 100).toFixed(2)}/${intervalOf(entry)}`)
  return created.id
}

async function ensurePackPrice(stripe: Stripe, entry: PackCatalogEntry, flags: Flags): Promise<string> {
  const productId = packProductId(entry.key)
  await ensureProduct(stripe, productId, `BuilderHunt Credits — ${entry.credits}`, { builderhunt_pack: entry.key, kind: 'pack' }, flags.mode === 'dry-run')

  const existing = await findPriceByLookupKey(stripe, entry.key)
  if (existing) {
    const diffs = validatePackPrice(entry, existing, productId)
    if (diffs.length) throw new MismatchError(entry.key, diffs)
    console.log(`  ok   ${entry.key.padEnd(16)} → ${existing.id} (validated, unchanged)`)
    return existing.id
  }
  if (flags.mode === 'validate') throw new MismatchError(entry.key, ['no Price exists with this lookup_key (validate mode will not create it)'])
  if (flags.mode === 'dry-run') {
    console.log(`  [dry-run] would CREATE pack price ${entry.key} = $${(entry.amountCents / 100).toFixed(2)} one-time`)
    return `price_DRYRUN_${entry.key}`
  }
  const created = await stripe.prices.create(
    {
      currency: 'usd',
      unit_amount: entry.amountCents,
      tax_behavior: 'exclusive',
      lookup_key: entry.key,
      transfer_lookup_key: true,
      product: productId,
      metadata: {
        catalog_key: entry.key,
        catalog_version: String(entry.version),
        credits: String(entry.credits),
        expiry_months: String(entry.expiryMonths),
        kind: 'pack',
      },
    },
    { idempotencyKey: `provision:pack:${entry.key}:v${entry.version}` },
  )
  console.log(`  created ${entry.key.padEnd(16)} → ${created.id} = $${(entry.amountCents / 100).toFixed(2)} one-time`)
  return created.id
}

/**
 * Patch catalog.ts in place, filling the resolved Price IDs into the correct
 * livemode column ("test" | "live"). Uses a targeted regex per catalog key so
 * it never touches amounts/intervals/other columns. Idempotent: re-running with
 * the same IDs is a no-op.
 */
function writePriceIdsToCatalog(ids: Record<string, string>, column: 'test' | 'live'): void {
  let src = readFileSync(CATALOG_PATH, 'utf8')
  let patched = 0
  for (const [key, priceId] of Object.entries(ids)) {
    // Matches: stripePriceId: { test: <anything>, live: <anything> }  on the entry whose `key: '<key>'` precedes it.
    const entryRe = new RegExp(
      `(key:\\s*'${key}'[\\s\\S]*?stripePriceId:\\s*\\{\\s*test:\\s*)([^,]+)(,\\s*live:\\s*)([^}]+?)\\s*\\}`,
    )
    const next = src.replace(entryRe, (_m, pre, testVal, mid, liveVal) => {
      const t = column === 'test' ? `'${priceId}'` : testVal.trim()
      const l = column === 'live' ? `'${priceId}'` : liveVal.trim()
      return `${pre}${t}${mid}${l} }`
    })
    if (next !== src) patched++
    src = next
  }
  writeFileSync(CATALOG_PATH, src, 'utf8')
  console.log(`\nPatched ${patched}/${Object.keys(ids).length} catalog entries (${column} column) in ${CATALOG_PATH}`)
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const secretKey = process.env.STRIPE_SECRET_KEY

  if (!secretKey && flags.mode !== 'dry-run') {
    console.error('STRIPE_SECRET_KEY is required (except in --dry-run). Export a sk_test_... key first.')
    process.exit(1)
  }
  const live = secretKey?.startsWith('sk_live_') ?? false
  if (live && !flags.allowLive) {
    console.error('Refusing to run against a LIVE key without --allow-live. Provision test mode first.')
    process.exit(1)
  }
  const column: 'test' | 'live' = live ? 'live' : 'test'

  console.log(`Mode: ${flags.mode} | Stripe env: ${flags.mode === 'dry-run' ? 'n/a' : column} | API version: ${API_VERSION}\n`)

  const stripe = new Stripe(secretKey ?? 'sk_test_dryrun', { apiVersion: API_VERSION, maxNetworkRetries: 2, appInfo: { name: 'BuilderHunt provisioner', version: '1.0.0' } })

  const ids: Record<string, string> = {}
  try {
    console.log('Subscriptions:')
    for (const entry of Object.values(SUBSCRIPTION_CATALOG)) ids[entry.key] = await ensureSubscriptionPrice(stripe, entry, flags)
    console.log('\nCredit packs:')
    for (const entry of Object.values(PACK_CATALOG)) ids[entry.key] = await ensurePackPrice(stripe, entry, flags)
  } catch (err) {
    if (err instanceof MismatchError) {
      console.error(`\n✖ ${err.message}`)
      console.error('\nNothing was mutated. Reconcile the divergence (archive & recreate, or fix the catalog) and re-run.')
      process.exit(2)
    }
    throw err
  }

  console.log('\nResolved Price IDs:')
  for (const [k, v] of Object.entries(ids)) console.log(`  ${k.padEnd(16)} ${v}`)

  if (flags.write && flags.mode === 'provision') {
    writePriceIdsToCatalog(ids, column)
    console.log('Review the diff with `git diff src/shared/lib/billing/catalog.ts` before committing.')
  } else if (flags.mode === 'provision') {
    console.log('\nRun again with --write to paste these IDs into catalog.ts, or copy them manually.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
