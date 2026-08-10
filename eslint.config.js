import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  // `.claude/worktrees` as well as `.worktrees`: both hold full checkouts of this same repository, and
  // linting a second copy of every file is not merely wasted work — typescript-eslint sees more than one
  // candidate tsconfig root and fails to parse anything at all, so one live worktree turned `pnpm lint`
  // into 1564 errors that named no real problem. The `.worktrees` entry only ever covered the older
  // convention; agent sessions create theirs under `.claude/`.
  { ignores: ['dist', '.tanstack', '.worktrees', '.claude/worktrees', 'node_modules', 'src/routeTree.gen.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Isomorphic app (TanStack Start): the same files run in the browser
    // and on the Node server, so both global sets apply everywhere.
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      // Pin the root the TypeScript service resolves from.
      //
      // Ignoring `.claude/worktrees` stops those files being *linted*, but the service still discovers
      // their `tsconfig.json` while resolving files outside `src/` — `scripts/**`, `server.prod.mjs` —
      // and then refuses to parse any of them: "No tsconfigRootDir was set, and multiple candidate
      // TSConfigRootDirs are present". One live agent worktree was enough to do it. Naming the root
      // makes the answer independent of whatever sibling checkouts happen to exist on disk.
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler-oriented diagnostics (this project doesn't use the
      // compiler) — keep as signal, don't hard-fail idiomatic existing code.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/gating': 'warn',
      'react-hooks/config': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
)
