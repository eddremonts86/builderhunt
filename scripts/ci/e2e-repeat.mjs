#!/usr/bin/env node
/**
 * Runs the Playwright suite twice and fails unless both runs agree.
 *
 * The point is not "did the tests pass" — `pnpm test:e2e` answers that. It is
 * "does this suite give the same answer twice", which is the only cheap way to
 * catch order dependence and leaked state between runs. A test that passes
 * alone and fails on the second pass is a test that will fail in CI at random.
 *
 * Divergence in either direction is a failure: a test that starts passing on
 * run two is as much a bug as one that starts failing.
 *
 * Any arguments are forwarded to Playwright, so `pnpm test:e2e:repeat
 * tests/e2e/onboarding.spec.ts` narrows both runs the same way.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const forwarded = process.argv.slice(2)

// The report goes to a FILE, not stdout, and that is a fix rather than a preference.
//
// This used to `JSON.parse(result.stdout)`, which could never work: the env loader prints
// `◇ injected env (67) from .env // tip: ⌘ override existing { override: true }` to stdout before Playwright
// writes a byte, so the parse always threw and every invocation died with "produced no parseable JSON report"
// — the script had never once completed a comparison, which is why nothing ever caught a flaky spec with it.
// Slicing from the first `{` would not have rescued it either: the first `{` is inside that banner.
//
// `PLAYWRIGHT_JSON_OUTPUT_NAME` is the documented way to get the report intact, and it is immune to anything
// else that decides to write to stdout later.
const reportDir = mkdtempSync(join(tmpdir(), 'e2e-repeat-'))

/** @param {number} attempt */
function runOnce(attempt) {
  const reportFile = join(reportDir, `run-${attempt}.json`)
  const result = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '--reporter=json', ...forwarded],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, E2E_RUN_ID: `repeat-${attempt}`, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
    },
  )

  // Playwright exits non-zero when tests fail, which is not itself an error
  // here — the comparison below is what decides. A missing/unparseable report
  // is a real failure: it means the runner never got far enough to produce one.
  let report
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'))
  } catch (error) {
    console.error(`Run ${attempt} produced no parseable JSON report at ${reportFile}: ${error.message}`)
    console.error(result.stdout.slice(-4000))
    console.error(result.stderr.slice(-4000))
    process.exit(1)
  }

  /** @type {Map<string, string>} */
  const outcomes = new Map()
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child)
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        outcomes.set(`${spec.file} › ${spec.title}`, t.status ?? 'unknown')
      }
    }
  }
  for (const suite of report.suites ?? []) walk(suite)
  return outcomes
}

console.log('E2E repeatability: run 1 of 2')
const first = runOnce(1)
console.log(`  ${first.size} tests recorded`)

console.log('E2E repeatability: run 2 of 2')
const second = runOnce(2)
console.log(`  ${second.size} tests recorded`)

const names = new Set([...first.keys(), ...second.keys()])
const diverged = []
for (const name of names) {
  const a = first.get(name) ?? '(absent)'
  const b = second.get(name) ?? '(absent)'
  if (a !== b) diverged.push(`  ${name}\n    run 1: ${a}\n    run 2: ${b}`)
}

if (diverged.length > 0) {
  console.error(`\n${diverged.length} test(s) did not give the same answer twice:\n`)
  console.error(diverged.join('\n'))
  process.exit(1)
}

const failed = [...first.entries()].filter(([, status]) => status !== 'expected' && status !== 'skipped')
if (failed.length > 0) {
  console.error(`\nBoth runs agree, but ${failed.length} test(s) failed in both:`)
  for (const [name, status] of failed) console.error(`  ${name} → ${status}`)
  process.exit(1)
}

rmSync(reportDir, { recursive: true, force: true })
console.log(`\nBoth runs agree across ${names.size} tests.`)
