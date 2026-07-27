#!/usr/bin/env node
/**
 * orchestrate.mjs — the single, idempotent production deploy orchestrator.
 *
 * This is the command Coolify's `post_deployment_command` should run
 * (`pnpm deploy:db`). It brings a freshly-started app container's database
 * from "empty or migrated-but-unusable" to "100% functional" in one ordered,
 * fail-loud, idempotent pass:
 *
 *   1. wait for the database to accept connections
 *   2. ensure the target database exists            (scripts/db/create-db.ts)
 *   3. ensure required extensions exist             (pgvector — soft/optional)
 *   4. apply Drizzle migrations                      (drizzle-kit migrate)
 *   5. PROVISION / ROTATE the LOGIN passwords for the least-privilege roles
 *      the migrations create WITHOUT passwords (builderhunt_app/worker/auth/
 *      platform). THIS is the step missing until now: without it the app role
 *      cannot authenticate, so every DB-backed page 500s, login breaks, and
 *      the HTTP-cron workers/scrapers (builderhunt_worker) fail 100%.
 *   6. verify every provisioned role can actually log in (fail early, loudly)
 *   7. seed the default admin user                   (scripts/db/seed-admin.ts)
 *
 * Design guarantees:
 *   - Idempotent: safe to re-run on every deploy. Forward-only. NEVER drops,
 *     resets, or `drizzle-kit push`es — existing data is preserved (durability).
 *   - Container-safe env: reads process.env (Coolify-injected). Optionally
 *     hydrates from .env.docker / .env if present (local runs). Does NOT depend
 *     on `tsx --env-file=.env`, which breaks in the container (only .env.docker
 *     is present there).
 *   - Secret-safe: role passwords are read from the connection URLs and used to
 *     ALTER ROLE, but are NEVER printed or logged.
 *
 * Flags:
 *   --dry-run     Print the ordered plan and what would change (role names only,
 *                 never passwords) without executing any mutation.
 *   --skip-seed   Skip the admin seed step (migrations + roles only).
 *
 * Usage:
 *   pnpm deploy:db
 *   pnpm deploy:db --dry-run
 *   node scripts/deploy/orchestrate.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import postgres from 'postgres'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DRY_RUN = process.argv.includes('--dry-run')
const SKIP_SEED = process.argv.includes('--skip-seed')

// Only these roles are ever password-provisioned by this script. Anything else
// (postgres, migration_operator, builderhunt_owner) is deliberately left alone
// so a misconfigured URL can never rotate a superuser/owner credential.
const PROVISIONABLE_ROLE = /^builderhunt_[a-z]+$/

// Runtime role connection URLs, in the order the app resolves them. Each that
// is set AND points at a provisionable role gets its password synced to the DB.
const ROLE_ENV_VARS = [
  { env: 'DATABASE_URL', label: 'app', required: true },
  { env: 'DATABASE_AUTH_URL', label: 'auth', required: false },
  { env: 'DATABASE_WORKER_URL', label: 'worker', required: false },
  { env: 'DATABASE_PLATFORM_URL', label: 'platform', required: false },
  // The accountless candidate portal's role (drizzle/0078_capability_role.sql).
  // Like every other role here it is created by the migration without a password,
  // so without this entry setting DATABASE_CAPABILITY_URL in Coolify would appear
  // to configure the portal while step 5 never synced the password onto the role
  // and the login kept failing. `required: false` keeps it inert until the
  // variable is actually set — the app falls back to the worker URL and the
  // public flow fails closed on a permission error, which is the intended
  // pre-rollout state.
  { env: 'DATABASE_CAPABILITY_URL', label: 'capability', required: false },
]

const WAIT_ATTEMPTS = Number.parseInt(process.env.DEPLOY_DB_WAIT_ATTEMPTS ?? '30', 10)
const WAIT_DELAY_MS = Number.parseInt(process.env.DEPLOY_DB_WAIT_DELAY_MS ?? '2000', 10)

// ── logging (never emits secret values) ──────────────────────────────────────
let stepNo = 0
const log = (msg) => console.log(msg)
const step = (msg) => log(`\n[${++stepNo}] ${msg}`)
const ok = (msg) => log(`    ✓ ${msg}`)
const warn = (msg) => log(`    ⚠ ${msg}`)
const info = (msg) => log(`    · ${msg}`)
function fail(msg, cause) {
  const err = new Error(msg)
  if (cause) err.cause = cause
  throw err
}

// ── container-safe env loading ───────────────────────────────────────────────
// process.env (Coolify-injected) always wins. If a local env file exists, use it
// to fill in only the vars that are not already set — so this works identically
// in the container (no file, injected env) and locally (.env / .env.docker).
function hydrateEnvFromFile(fileName) {
  const filePath = join(ROOT, fileName)
  if (!existsSync(filePath)) return false
  const raw = readFileSync(filePath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = val
    }
  }
  return true
}

// ── url parsing ──────────────────────────────────────────────────────────────
function parseConn(url) {
  const u = new URL(url.replace(/^postgres:\/\//, 'postgresql://'))
  return {
    url,
    role: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port || '5432',
    db: u.pathname.replace(/^\//, ''),
  }
}

// Redact the password from a connection URL for safe logging.
function redactUrl(url) {
  try {
    const u = new URL(url.replace(/^postgres:\/\//, 'postgresql://'))
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '[unparseable-url]'
  }
}

// ── child process helpers ────────────────────────────────────────────────────
function runBin(bin, args) {
  const binPath = join(ROOT, 'node_modules', '.bin', bin)
  const exe = existsSync(binPath) ? binPath : bin
  execFileSync(exe, args, { stdio: 'inherit', cwd: ROOT, env: process.env })
}

// ── steps ────────────────────────────────────────────────────────────────────
async function waitForDatabase(migrationUrl) {
  step(`Waiting for database (${redactUrl(migrationUrl)})`)
  if (DRY_RUN) {
    info(`would retry SELECT 1 up to ${WAIT_ATTEMPTS}× every ${WAIT_DELAY_MS}ms`)
    return
  }
  let lastErr
  for (let attempt = 1; attempt <= WAIT_ATTEMPTS; attempt++) {
    const sql = postgres(migrationUrl, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 2 })
    try {
      await sql`SELECT 1`
      await sql.end({ timeout: 5 })
      ok(`database reachable (attempt ${attempt}/${WAIT_ATTEMPTS})`)
      return
    } catch (err) {
      lastErr = err
      await sql.end({ timeout: 5 }).catch(() => {})
      if (attempt < WAIT_ATTEMPTS) {
        info(`not ready (attempt ${attempt}/${WAIT_ATTEMPTS}) — retrying in ${WAIT_DELAY_MS}ms`)
        await new Promise((r) => setTimeout(r, WAIT_DELAY_MS))
      }
    }
  }
  fail(`database did not become reachable after ${WAIT_ATTEMPTS} attempts`, lastErr)
}

function ensureDatabaseExists() {
  step('Ensuring database exists (scripts/db/create-db.ts)')
  if (DRY_RUN) {
    info('would run: tsx scripts/db/create-db.ts (idempotent CREATE DATABASE)')
    return
  }
  runBin('tsx', ['scripts/db/create-db.ts'])
  ok('database present')
}

async function ensureExtensions(migrationUrl) {
  step('Ensuring required Postgres extensions')
  const extensions = ['vector'] // pgvector — required by builder_embeddings (semantic search)
  if (DRY_RUN) {
    for (const ext of extensions) info(`would run: CREATE EXTENSION IF NOT EXISTS ${ext}`)
    return
  }
  const sql = postgres(migrationUrl, { max: 1, prepare: false })
  try {
    for (const ext of extensions) {
      try {
        await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ext}`)
        ok(`extension "${ext}" present`)
      } catch (err) {
        // Fail-soft: the app degrades gracefully when pgvector is missing
        // (semantic search falls back to keyword). Surface it loudly so an
        // operator can enable the pgvector image, but do not abort the deploy.
        const code = err && typeof err === 'object' && 'code' in err ? err.code : null
        warn(`could not create extension "${ext}" (code ${code ?? 'unknown'}).`)
        warn(`  → switch the managed Postgres image to pgvector/pgvector:pg16 and re-run,`)
        warn(`    or run CREATE EXTENSION vector as a superuser. Semantic search stays`)
        warn(`    disabled (keyword fallback) until then — not an outage.`)
      }
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function runMigrations() {
  step('Applying Drizzle migrations (drizzle-kit migrate)')
  if (DRY_RUN) {
    info('would run: drizzle-kit migrate (forward-only, never push/reset)')
    return
  }
  runBin('drizzle-kit', ['migrate'])
  ok('migrations applied')
}

async function provisionRolePasswords(migrationUrl, migrationRole) {
  step('Provisioning / rotating role LOGIN passwords')
  const targets = []
  for (const { env, label, required } of ROLE_ENV_VARS) {
    const url = process.env[env]
    if (!url) {
      if (required) fail(`${env} is required but not set`)
      info(`${env} unset — role "${label}" falls back to DATABASE_URL (nothing to provision)`)
      continue
    }
    const conn = parseConn(url)
    if (!PROVISIONABLE_ROLE.test(conn.role)) {
      warn(`${env} uses role "${conn.role}" — not a builderhunt_* role, skipping (will not rotate)`)
      continue
    }
    if (conn.role === migrationRole) {
      warn(`${env} uses the migration role "${conn.role}" — skipping (never rotate the migration identity)`)
      continue
    }
    if (!conn.password) {
      warn(`${env} has no password component — skipping role "${conn.role}"`)
      continue
    }
    // De-duplicate by role name (auth/worker/platform may all point at app).
    if (!targets.some((t) => t.role === conn.role)) targets.push({ env, label, conn })
  }

  if (targets.length === 0) {
    warn('no builderhunt_* runtime roles to provision (single-role deploy via DATABASE_URL)')
    return targets
  }

  if (DRY_RUN) {
    for (const t of targets) info(`would run: ALTER ROLE ${t.conn.role} WITH LOGIN PASSWORD '***'  (from ${t.env})`)
    return targets
  }

  const sql = postgres(migrationUrl, { max: 1, prepare: false })
  try {
    for (const t of targets) {
      // Role name is validated against PROVISIONABLE_ROLE (safe identifier).
      // The password is escaped as a standard Postgres string literal ('' for ').
      const escaped = t.conn.password.replace(/'/g, "''")
      await sql.unsafe(`ALTER ROLE ${t.conn.role} WITH LOGIN PASSWORD '${escaped}'`)
      ok(`role "${t.conn.role}" password synced (from ${t.env})`)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
  return targets
}

async function verifyRoleLogins(targets) {
  step('Verifying runtime roles can authenticate')
  if (targets.length === 0) {
    info('nothing to verify (no dedicated runtime roles)')
    return
  }
  if (DRY_RUN) {
    for (const t of targets) info(`would connect as "${t.conn.role}" and run SELECT 1`)
    return
  }
  for (const t of targets) {
    const sql = postgres(t.conn.url, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 2 })
    try {
      await sql`SELECT 1`
      ok(`role "${t.conn.role}" authenticated`)
    } catch (err) {
      await sql.end({ timeout: 5 }).catch(() => {})
      fail(
        `role "${t.conn.role}" (${t.env}) could NOT authenticate after provisioning — ` +
          `the runtime password in ${t.env} does not match the DB role. Fix the env var and redeploy.`,
        err,
      )
    }
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

function seedAdmin() {
  step('Seeding default admin user (scripts/db/seed-admin.ts)')
  if (SKIP_SEED) {
    info('--skip-seed set — skipping')
    return
  }
  if (DRY_RUN) {
    info('would run: tsx scripts/db/seed-admin.ts (idempotent upsert)')
    return
  }
  try {
    runBin('tsx', ['scripts/db/seed-admin.ts'])
    ok('admin user ready')
  } catch (err) {
    // Best-effort: migrations + roles already succeeded, so the app is up. A
    // missing/failed admin seed is recoverable (re-run once creds are set) and
    // must not brick an otherwise-successful deploy.
    warn('admin seed failed — the deploy is otherwise healthy.')
    warn('  → ensure DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD are set in the')
    warn('    Coolify env panel, then re-run `pnpm deploy:db` (or --skip-seed to ignore).')
    info(`reason: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('━━━ builderhunt deploy orchestrator ━━━')
  if (DRY_RUN) log('(dry-run: no mutations will be performed)')

  // process.env (Coolify-injected) wins; hydrate missing keys from a local
  // env file when present (.env.docker in the container, .env in local runs).
  if (!hydrateEnvFromFile('.env.docker')) hydrateEnvFromFile('.env')

  const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
  if (!migrationUrl) {
    fail('DATABASE_MIGRATION_URL (or DATABASE_URL fallback) is not set — cannot orchestrate deploy')
  }
  const migrationRole = parseConn(migrationUrl).role
  info(`migration identity: ${migrationRole} @ ${redactUrl(migrationUrl)}`)

  await waitForDatabase(migrationUrl)
  ensureDatabaseExists()
  await ensureExtensions(migrationUrl)
  runMigrations()
  const provisioned = await provisionRolePasswords(migrationUrl, migrationRole)
  await verifyRoleLogins(provisioned)
  seedAdmin()

  log('\n━━━ deploy orchestration complete ✓ ━━━')
  if (DRY_RUN) log('(dry-run — re-run without --dry-run to apply)')
}

main().catch((err) => {
  console.error('\n━━━ deploy orchestration FAILED ✗ ━━━')
  console.error(err instanceof Error ? `${err.message}` : String(err))
  if (err instanceof Error && err.cause) {
    const cause = err.cause
    console.error(`caused by: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  process.exit(1)
})
