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

const forwarded = process.argv.slice(2)

/** @param {number} attempt */
function runOnce(attempt) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '--reporter=json', ...forwarded],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, E2E_RUN_ID: `repeat-${attempt}` } },
  )

  // Playwright exits non-zero when tests fail, which is not itself an error
  // here — the comparison below is what decides. A missing/unparseable report
  // is a real failure: it means the runner never got far enough to produce one.
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    console.error(`Run ${attempt} produced no parseable JSON report.`)
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

console.log(`\nBoth runs agree across ${names.size} tests.`)
