// Metering-bypass boundary test (plans/abuse-and-usage-integrity/tasks.md
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

// Whole-file exemptions for call sites that are legitimately NOT a
// tenant-billed feature — every entry must justify why.
const fileAllowlist = new Map([
  [
    'src/lib/semantic/embed-worker.ts',
    'internal scheduled backfill worker (external cron, no per-request principal/entitlement to bill)',
  ],
  [
    'src/routes/api/ai/embed.ts',
    'platform-admin-only embedding backfill operator surface, not a tenant-billed feature (requirePlatformAdminPrincipal + rate limit)',
  ],
])

const providerImportPatterns = [
  { name: 'minimaxChat', pattern: /\bminimaxChat\s*\(/ },
  { name: 'embedTexts', pattern: /\bembedTexts\s*\(/ },
]
const gatePattern = /\b(?:checkAndConsumeBudget|reserveCredits)\s*\(/
const functionStartPattern = /(?:^|\s)(?:async\s+)?function\b|=>\s*\{|=\s*(?:async\s*)?\(/

const files = await sourceFiles(sourceRoot)
const findings = []

for (const absolutePath of files) {
  const path = relative(root, absolutePath)
  const source = await readFile(absolutePath, 'utf8')
  const importsProvider = /from\s+['"]~\/shared\/lib\/ai\/(minimax|embeddings)['"]/.test(source)
  if (!importsProvider) continue

  const lines = source.split('\n')
  const functionStack = [] // { startLine, gated: boolean }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (functionStartPattern.test(line)) {
      functionStack.push({ startLine: i, gated: false })
    }

    if (gatePattern.test(line) && functionStack.length > 0) {
      functionStack[functionStack.length - 1].gated = true
    }

    for (const { name, pattern } of providerImportPatterns) {
      if (!pattern.test(line)) continue
      const enclosing = functionStack[functionStack.length - 1]
      const gated = enclosing?.gated ?? false
      if (!gated && !fileAllowlist.has(path)) {
        findings.push(`${path}:${i + 1}: ${name}() call is not preceded by checkAndConsumeBudget()/reserveCredits() in its enclosing function`)
      }
    }

    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    for (let c = 0; c < closes - opens; c += 1) functionStack.pop()
    for (let o = 0; o < opens - closes - 1; o += 1) functionStack.push({ startLine: i, gated: functionStack[functionStack.length - 1]?.gated ?? false })
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
