#!/usr/bin/env node
/**
 * preflight.mjs — local pre-deploy gate (`pnpm deploy:preflight`).
 *
 * Run this before pushing to master. It reproduces, on your machine, the exact
 * failure modes that otherwise only surface once Coolify is already mid-deploy:
 *
 *   - lockfile drift        → `pnpm install --frozen-lockfile` (the Docker build
 *                             uses --frozen-lockfile; if it fails here it fails there)
 *   - type errors           → `pnpm type-check`
 *   - migration journal drift → `pnpm test:migration-integrity` (a .sql file with
 *                             no journal/hash entry is silently skipped by
 *                             drizzle-kit migrate — the classic "migrations said OK
 *                             but the table is missing" production break)
 *   - build breakage        → `pnpm build`
 *   - leaked secrets        → high-signal scan of src/ (sk_live_, whsec_, keys)
 *   - deploy hygiene        → Dockerfile + .dockerignore present, prod env template
 *                             has the critical keys
 *
 * Every check runs (so you see the full picture); the script exits non-zero if
 * any hard check failed. Warnings never fail the gate.
 *
 * Flags:
 *   --quick   Skip the slow build step (type-check + migration integrity still run).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const QUICK = process.argv.includes('--quick')

const results = [] // { name, status: 'pass' | 'fail' | 'warn', detail }
const record = (name, status, detail = '') => results.push({ name, status, detail })

const log = (m) => console.log(m)
const header = (m) => log(`\n\u2500\u2500 ${m} \u2500\u2500`)

function runCmd(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, env: { ...process.env } })
}

// A hard check: pass unless it throws.
function check(name, fn) {
  header(name)
  try {
    fn()
    record(name, 'pass')
    log(`\u2713 ${name}`)
  } catch (err) {
    record(name, 'fail', err instanceof Error ? err.message : String(err))
    log(`\u2717 ${name}`)
  }
}

// A soft check: records a warning instead of failing the gate.
function soft(name, fn) {
  header(name)
  try {
    const msg = fn()
    if (msg) {
      record(name, 'warn', msg)
      log(`\u26a0 ${name}: ${msg}`)
    } else {
      record(name, 'pass')
      log(`\u2713 ${name}`)
    }
  } catch (err) {
    record(name, 'warn', err instanceof Error ? err.message : String(err))
    log(`\u26a0 ${name}`)
  }
}

// ── checks ───────────────────────────────────────────────────────────────────
check('lockfile committed', () => {
  if (!existsSync(join(ROOT, 'pnpm-lock.yaml'))) throw new Error('pnpm-lock.yaml missing')
})

check('frozen install (reproducible build)', () => {
  // CI=true mirrors the Dockerfile so pnpm reconciles node_modules to the
  // lockfile non-interactively instead of prompting for a TTY confirmation.
  execFileSync('pnpm', ['install', '--frozen-lockfile'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, CI: 'true' },
  })
})

check('type-check', () => {
  runCmd('pnpm', ['type-check'])
})

check('migration integrity', () => {
  runCmd('pnpm', ['test:migration-integrity'])
})

if (!QUICK) {
  check('build', () => {
    runCmd('pnpm', ['build'])
  })
} else {
  record('build', 'warn', 'skipped (--quick)')
  log('\n\u26a0 build skipped (--quick)')
}

check('no leaked secrets in src/', () => {
  const patterns = [
    { re: /sk_live_[0-9a-zA-Z]{8,}/, label: 'Stripe live secret key' },
    { re: /whsec_[0-9a-zA-Z]{16,}/, label: 'Stripe webhook secret' },
    { re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, label: 'private key' },
    { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key id' },
  ]
  const hits = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git') continue
        walk(full)
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
        const text = readFileSync(full, 'utf8')
        for (const { re, label } of patterns) {
          if (re.test(text)) hits.push(`${full.replace(ROOT + '/', '')} — ${label}`)
        }
      }
    }
  }
  walk(join(ROOT, 'src'))
  if (hits.length) throw new Error(`potential secrets found:\n  - ${hits.join('\n  - ')}`)
})

check('deploy files present', () => {
  const required = ['Dockerfile', '.dockerignore', 'server.prod.mjs', 'scripts/deploy/orchestrate.mjs']
  const missing = required.filter((f) => !existsSync(join(ROOT, f)))
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`)
})

soft('production env template has critical keys', () => {
  const tpl = join(ROOT, '.env.production.example')
  if (!existsSync(tpl)) return '.env.production.example missing'
  const text = readFileSync(tpl, 'utf8')
  const critical = [
    'NODE_ENV',
    'APP_URL',
    'DATABASE_URL',
    'DATABASE_MIGRATION_URL',
    'BETTER_AUTH_SECRET',
  ]
  const missing = critical.filter((k) => !new RegExp(`^${k}=`, 'm').test(text))
  return missing.length ? `missing keys: ${missing.join(', ')}` : ''
})

// ── summary ──────────────────────────────────────────────────────────────────
header('summary')
for (const r of results) {
  const icon = r.status === 'pass' ? '\u2713' : r.status === 'warn' ? '\u26a0' : '\u2717'
  log(`  ${icon} ${r.name}${r.detail ? ` — ${r.detail.split('\n')[0]}` : ''}`)
}

const failed = results.filter((r) => r.status === 'fail')
if (failed.length) {
  log(`\n\u2717 preflight FAILED (${failed.length} check${failed.length > 1 ? 's' : ''}). Do not deploy until fixed.`)
  process.exit(1)
}
log('\n\u2713 preflight passed. Safe to push / deploy.')
