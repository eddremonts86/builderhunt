// Metering-bypass boundary test (plans/implemented/32-abuse-and-usage-integrity/tasks.md
// Phase 4B "G8"). Every server-side call into the MiniMax provider
// (`minimaxChat`) or the embeddings provider (`embedTexts`) must be preceded,
// within the SAME enclosing function, by a call to one of the two
// established metering gates: `checkAndConsumeBudget` (ai/budget.ts — the
// per-user/per-task daily call-count allowance) or `reserveCredits`
// (billing/feature-authorization.ts — the monetary credit-ledger
// reservation). A file-level check is not enough: a single file can contain
// both a gated and an ungated call site (see `src/lib/semantic/semantic-search.ts`,
// which has one of each until Phase 4B's fix), so this walks function
// boundaries via brace-depth tracking rather than just grepping the whole file.
//
// The free/local (Chrome on-device) AI tier (`ai/local.ts`) never imports
// `ai/minimax.ts`/`ai/embeddings.ts` at all — it calls the browser's
// `LanguageModel` global directly — so it never appears in this scan and
// needs no allowlist entry.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()
const sourceRoot = join(root, 'src')

// Whole-file exemptions. Two shapes qualify, and every entry must say which and why.
//
//   1. The call is legitimately NOT a tenant-billed feature.
//   2. The call IS billed, but by an enclosing boundary this file-local check cannot see — in which case the
//      entry must name where the metering is and what proves it.
//
// Shape 2 was added for Solutions (plan 43 Phase 7). Its two provider wrappers are deliberately decoupled from
// billing: `interpret.ts` imports no billing at all, and a test asserts the absence of the import, because that
// is the mechanism behind "charge nothing before confirmation". Putting a `reserveCredits` call into the same
// function to satisfy a grep would invert the design the gate is meant to protect.
const fileAllowlist = new Map([
  [
    'src/lib/semantic/embed-worker.ts',
    'internal scheduled backfill worker (external cron, no per-request principal/entitlement to bill)',
  ],
  [
    'src/routes/api/ai/embed.ts',
    'platform-admin-only embedding backfill operator surface, not a tenant-billed feature (requirePlatformAdminPrincipal + rate limit)',
  ],
  [
    'src/lib/solutions/ai/interpret.ts',
    'billed by the caller: every invocation runs inside withSolutionsCredits\' work callback (modules/solutions/server/generate.ts). This module imports no billing on purpose — tests/unit/lib/solutions/ai-interpret.test.ts asserts the absent import, and tests/unit/modules/solutions/generate.test.ts asserts a reserved row exists before the interpreting stage runs',
  ],
  [
    'src/lib/solutions/ai/explain.ts',
    'billed by the caller: same withSolutionsCredits boundary as interpret.ts, asserted by tests/unit/modules/solutions/generate.test.ts ("has a reserved row by the time interpretation starts") and by the billing suite\'s ordering test',
  ],
])

const providerImportPatterns = [
  { name: 'minimaxChat', pattern: /\bminimaxChat\s*\(/ },
  { name: 'embedTexts', pattern: /\bembedTexts\s*\(/ },
]
const gatePattern = /\b(?:checkAndConsumeBudget|reserveCredits)\s*\(/

const files = await sourceFiles(sourceRoot)
const findings = []

for (const absolutePath of files) {
  const path = relative(root, absolutePath)
  const source = await readFile(absolutePath, 'utf8')
  const importsProvider = /from\s+['"]~\/shared\/lib\/ai\/(minimax|embeddings)['"]/.test(source)
  if (!importsProvider) continue

  const lines = source.split('\n')
  // Depth-based scoping, not a real parser: `depth` is the running brace
  // balance from the top of the file. Whenever it returns to 0 we've closed
  // back out to top level (between two sibling top-level declarations), so
  // `gatedInScope` resets — this correctly isolates one top-level function
  // from the next without needing to detect what a "function" looks like.
  // Nested braces inside a function (object literals, if-blocks, other
  // provider-call arguments) never bring `depth` back to 0 mid-function, so
  // they don't reset the flag early.
  let depth = 0
  let gatedInScope = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (gatePattern.test(line)) gatedInScope = true

    for (const { name, pattern } of providerImportPatterns) {
      if (!pattern.test(line)) continue
      if (!gatedInScope && !fileAllowlist.has(path)) {
        findings.push(`${path}:${i + 1}: ${name}() call is not preceded by checkAndConsumeBudget()/reserveCredits() in its enclosing top-level function`)
      }
    }

    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    depth += opens - closes
    if (depth <= 0) {
      depth = 0
      gatedInScope = false
    }
  }
}

// Staleness check, mirroring check-route-coverage.mjs: an allowlisted file
// that no longer imports either provider function is a stale entry.
const filesByPath = new Set(files.map((absolutePath) => relative(root, absolutePath)))
for (const [path, reason] of fileAllowlist) {
  if (!filesByPath.has(path)) {
    findings.push(`${path}: allowlisted ("${reason}") but no longer exists — remove the stale entry`)
    continue
  }
}

if (findings.length > 0) {
  console.error(findings.sort().join('\n'))
  process.exitCode = 1
} else {
  console.log(`Provider metering check passed (${fileAllowlist.size} files allowlisted)`)
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}
