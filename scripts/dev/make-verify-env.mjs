#!/usr/bin/env node
/**
 * Derives a shell-sourceable env file pointing at a throwaway database.
 *
 * `pnpm dev` reads `.env` through dotenv, which is *not* the same as `set -a; . ./.env`. Three
 * differences bite, and each one produced a failure that looked like an application bug:
 *
 *  1. **Inline comments.** `STRIPE_BILLING_ENABLED=false   # note` is `false` to dotenv and
 *     `false   # note` to a shell. The env schema rejected the second and the app 500'd on boot with a
 *     ZodError about a flag nobody had touched.
 *  2. **Empty values.** `GITHUB_TOKEN=` is *absent* to dotenv, so the schema default applies. Exporting it
 *     as an empty string makes a required-or-enum field fail.
 *  3. **Rewriting the database name.** A blind `replace('/builderhunt', ...)` also rewrites the *username*
 *     in `postgresql://builderhunt_auth:…`, so every role connection fails 28P01 — which surfaces as a 500
 *     from whatever route you happened to be testing.
 *
 * Usage:
 *   node scripts/dev/make-verify-env.mjs [--database builderhunt_verify] [--out .env.verify]
 *
 * Then create and migrate that database, and run the dev server with it:
 *   createdb builderhunt_verify
 *   set -a; . ./.env.verify; set +a; pnpm exec drizzle-kit migrate
 *
 * The output file contains the same secrets as `.env`. It is written for local verification only — add it
 * to `.git/info/exclude` and delete it when finished.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { urlToHttpOptions } from 'node:url'

const args = process.argv.slice(2)
const valueOf = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const database = valueOf('--database', 'builderhunt_verify')
const out = valueOf('--out', '.env.verify')
const source = valueOf('--source', '.env')

/** Single-quotes for the shell, with embedded quotes escaped the POSIX way. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const lines = readFileSync(source, 'utf8').split('\n')
const emitted = []
const report = { repointed: [], decommented: [], dropped: [] }

for (const line of lines) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
  if (!match) continue
  const [, name, raw] = match

  let value
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0])) {
    value = trimmed.slice(1, -1)
  } else {
    // `\s+#` and not just `#`: a value may legitimately contain a hash (a URL fragment, a password).
    const [head, comment] = trimmed.split(/\s+#(.*)$/s)
    if (comment !== undefined) report.decommented.push(name)
    value = head.trim()
  }

  if (value === '') {
    report.dropped.push(name)
    continue
  }

  if (name.startsWith('DATABASE_')) {
    try {
      const url = new URL(value)
      // The pathname only. `urlToHttpOptions` is imported to make the intent explicit: the username,
      // password, host and port all stay exactly as they were.
      void urlToHttpOptions
      url.pathname = `/${database}`
      value = url.toString()
      report.repointed.push(name)
    } catch {
      // Not a URL (a bare database name, a socket path). Left alone rather than mangled.
    }
  }

  emitted.push(`${name}=${shellQuote(value)}`)
}

emitted.push(
  '',
  '# Interview features, on for verification. Transcription additionally requires a DEEPGRAM_API_KEY',
  '# and a DEEPGRAM_BASE_URL on the EU endpoint, which the env schema enforces together.',
  `INTERVIEW_TRANSCRIPTION_ENABLED='true'`,
  `CANDIDATE_UPLOADS_ENABLED='true'`,
  '# Left off: with it on, briefs call Mistral for real. The deterministic fallback is what runs otherwise.',
  `SENSITIVE_AI_ENABLED='false'`,
)

writeFileSync(out, `${emitted.join('\n')}\n`)

console.log(JSON.stringify({
  out,
  database,
  variables: emitted.filter((line) => line.includes('=')).length,
  repointed: report.repointed.length,
  inlineCommentsStripped: report.decommented,
  emptyValuesDropped: report.dropped,
}, null, 2))
