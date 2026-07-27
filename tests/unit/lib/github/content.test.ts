import { describe, expect, it } from 'vitest'
import {
  avgCommentDensity,
  commentDensity,
  compareCandidates,
  EXCLUDED_PATH_RE,
  extensionsForLanguage,
  isCandidateFile,
  pickSampleFiles,
  selectRepos,
  testFileRatio,
  truncateForPrompt,
  type TreeEntry,
} from '~/lib/github/content'

const blob = (path: string, size: number): TreeEntry => ({ path, type: 'blob', size })

/** A conventional single-language repo. */
const NORMAL_TREE: TreeEntry[] = [
  blob('README.md', 4_000),
  blob('src/index.ts', 8_000),
  blob('src/parser.ts', 12_000),
  blob('src/utils.ts', 2_000),
  blob('src/__tests__/parser.test.ts', 6_000),
  blob('package.json', 900),
  { path: 'src', type: 'tree' },
]

/** A repo where the real code is buried under vendored/build output. */
const VENDORED_TREE: TreeEntry[] = [
  blob('node_modules/left-pad/index.js', 8_000),
  blob('dist/bundle.min.js', 8_000),
  blob('vendor/jquery.js', 8_000),
  blob('third_party/lib.ts', 8_000),
  blob('build/out.ts', 8_000),
  blob('generated/schema.ts', 8_000),
  blob('pnpm-lock.yaml', 90_000),
  blob('src/real-code.ts', 8_100),
]

describe('EXCLUDED_PATH_RE', () => {
  it.each([
    'node_modules/x/index.js',
    'vendor/jquery.js',
    'dist/app.js',
    'build/out.js',
    'out/main.js',
    'generated/schema.ts',
    'app/__snapshots__/x.snap',
    'third_party/lib.c',
    'app.min.js',
    'pnpm-lock.yaml',
    'package-lock.json',
    'Cargo.lock',
  ])('excludes %s', (path) => {
    expect(EXCLUDED_PATH_RE.test(path)).toBe(true)
  })

  it.each(['src/index.ts', 'lib/parser.rs', 'main.go', 'app/models/user.rb'])(
    'keeps %s',
    (path) => {
      expect(EXCLUDED_PATH_RE.test(path)).toBe(false)
    },
  )

  it('does not exclude a legitimate path that merely contains a keyword', () => {
    // `distance.ts` starts with "dist" but is not the `dist/` directory.
    expect(EXCLUDED_PATH_RE.test('src/distance.ts')).toBe(false)
    expect(EXCLUDED_PATH_RE.test('src/outbox.ts')).toBe(false)
  })
})

describe('extensionsForLanguage', () => {
  it('maps a known language to its extensions', () => {
    expect(extensionsForLanguage('TypeScript')).toEqual(['ts', 'tsx'])
    expect(extensionsForLanguage('rust')).toEqual(['rs'])
  })

  it('falls back to every known code extension for an unknown or absent language', () => {
    expect(extensionsForLanguage('Brainfuck')).toContain('ts')
    expect(extensionsForLanguage(null)).toContain('py')
  })
})

describe('isCandidateFile', () => {
  it('accepts an in-language source file inside the size band', () => {
    expect(isCandidateFile(blob('src/index.ts', 8_000), 'TypeScript')).toBe(true)
  })

  it('rejects trees, excluded paths, and out-of-language files', () => {
    expect(isCandidateFile({ path: 'src', type: 'tree' }, 'TypeScript')).toBe(false)
    expect(isCandidateFile(blob('node_modules/a/i.ts', 8_000), 'TypeScript')).toBe(false)
    expect(isCandidateFile(blob('README.md', 8_000), 'TypeScript')).toBe(false)
    expect(isCandidateFile(blob('main.py', 8_000), 'TypeScript')).toBe(false)
  })

  it('rejects files outside the 1KB–40KB band', () => {
    expect(isCandidateFile(blob('src/tiny.ts', 100), 'TypeScript')).toBe(false)
    expect(isCandidateFile(blob('src/huge.ts', 999_999), 'TypeScript')).toBe(false)
  })

  it('rejects an entry with no size rather than guessing', () => {
    expect(isCandidateFile({ path: 'src/index.ts', type: 'blob' }, 'TypeScript')).toBe(false)
  })
})

describe('compareCandidates', () => {
  it('prefers src/ and root over deeply nested paths', () => {
    const nested = blob('app/features/deep/thing.ts', 8_000)
    const inSrc = blob('src/thing.ts', 8_000)
    expect(compareCandidates(inSrc, nested)).toBeLessThan(0)
  })

  it('prefers size closest to 8KB within the same tier', () => {
    const ideal = blob('src/a.ts', 8_000)
    const small = blob('src/b.ts', 1_200)
    expect(compareCandidates(ideal, small)).toBeLessThan(0)
  })

  it('is deterministic for identical rank (ties break on path)', () => {
    const a = blob('src/a.ts', 8_000)
    const b = blob('src/b.ts', 8_000)
    expect(compareCandidates(a, b)).toBeLessThan(0)
    expect(compareCandidates(b, a)).toBeGreaterThan(0)
  })
})

describe('pickSampleFiles', () => {
  it('ranks a normal repo by closeness to the ideal size, within src/', () => {
    // Every .ts here is tier 0 (root or src/), so ordering is purely
    // |size - 8192|: index 192, parser.test 2192, parser 3808, utils 6192.
    expect(pickSampleFiles(NORMAL_TREE, 'TypeScript', 4).map((e) => e.path)).toEqual([
      'src/index.ts',
      'src/__tests__/parser.test.ts',
      'src/parser.ts',
      'src/utils.ts',
    ])
  })

  it('excludes non-source files regardless of size', () => {
    const picked = pickSampleFiles(NORMAL_TREE, 'TypeScript', 8).map((e) => e.path)
    expect(picked).not.toContain('README.md')
    expect(picked).not.toContain('package.json')
  })

  it('samples test files as style evidence — they are code the author wrote', () => {
    // Deliberate: `testFileRatio` measures test *intensity* separately from the
    // tree, so test sources still count as a legitimate style sample here.
    expect(pickSampleFiles(NORMAL_TREE, 'TypeScript', 2).map((e) => e.path)).toContain(
      'src/__tests__/parser.test.ts',
    )
  })

  it('skips vendored/build/generated junk and finds the one real file', () => {
    expect(pickSampleFiles(VENDORED_TREE, 'TypeScript', 5).map((e) => e.path)).toEqual([
      'src/real-code.ts',
    ])
  })

  it('returns an empty list when nothing is usable (all-forks / empty repo)', () => {
    expect(pickSampleFiles([], 'TypeScript', 8)).toEqual([])
    expect(pickSampleFiles([blob('README.md', 2_000)], 'TypeScript', 8)).toEqual([])
  })

  it('respects the max', () => {
    expect(pickSampleFiles(NORMAL_TREE, 'TypeScript', 1)).toHaveLength(1)
    expect(pickSampleFiles(NORMAL_TREE, 'TypeScript', 0)).toHaveLength(0)
  })
})

describe('testFileRatio', () => {
  it('is 0 for a tree with no code files rather than NaN', () => {
    expect(testFileRatio([])).toBe(0)
    expect(testFileRatio(['README.md', 'LICENSE'])).toBe(0)
  })

  it('counts test directories and .test./.spec. suffixes', () => {
    expect(testFileRatio(['src/a.ts', 'src/__tests__/a.test.ts'])).toBe(0.5)
    expect(testFileRatio(['a.ts', 'a.spec.ts', 'b.ts', 'b.test.ts'])).toBe(0.5)
    expect(testFileRatio(['test/a.ts', 'spec/b.ts'])).toBe(1)
  })

  it('ignores excluded paths when computing the ratio', () => {
    // The vendored test files must not inflate the ratio.
    expect(testFileRatio(['src/a.ts', 'node_modules/x/x.test.js'])).toBe(0)
  })
})

describe('commentDensity', () => {
  it('is 0 for empty or all-code content', () => {
    expect(commentDensity('')).toBe(0)
    expect(commentDensity('const a = 1\nconst b = 2')).toBe(0)
  })

  it('counts leading comment markers across languages', () => {
    expect(commentDensity('// a\nconst x = 1')).toBe(0.5)
    expect(commentDensity('# py comment\nx = 1')).toBe(0.5)
    expect(commentDensity('-- sql\nselect 1')).toBe(0.5)
  })

  it('ignores blank lines so whitespace does not dilute the ratio', () => {
    expect(commentDensity('// a\n\n\nconst x = 1')).toBe(0.5)
  })

  it('averages across samples', () => {
    expect(avgCommentDensity([{ content: '// a\nx' }, { content: 'y\nz' }])).toBe(0.25)
    expect(avgCommentDensity([])).toBe(0)
  })
})

describe('selectRepos', () => {
  const now = new Date('2026-07-25T00:00:00Z').getTime()
  const repo = (over: Partial<Parameters<typeof selectRepos>[0][number]>) => ({
    name: 'r', fork: false, size: 100, stargazers_count: 0,
    pushed_at: '2026-07-01T00:00:00Z', default_branch: 'main', language: 'TypeScript',
    ...over,
  })

  it('drops forks and empty repos', () => {
    const out = selectRepos([repo({ name: 'f', fork: true }), repo({ name: 'e', size: 0 }), repo({ name: 'ok' })], 3, now)
    expect(out.map((r) => r.name)).toEqual(['ok'])
  })

  it('drops repos not pushed within 24 months', () => {
    const out = selectRepos([repo({ name: 'stale', pushed_at: '2020-01-01T00:00:00Z' }), repo({ name: 'fresh' })], 3, now)
    expect(out.map((r) => r.name)).toEqual(['fresh'])
  })

  it('ranks by stars and caps at max', () => {
    const out = selectRepos(
      [repo({ name: 'a', stargazers_count: 1 }), repo({ name: 'b', stargazers_count: 99 }), repo({ name: 'c', stargazers_count: 50 })],
      2, now,
    )
    expect(out.map((r) => r.name)).toEqual(['b', 'c'])
  })
})

describe('truncateForPrompt', () => {
  it('caps at 300 lines', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    expect(truncateForPrompt(long).split('\n')).toHaveLength(300)
  })

  it('caps at 20k chars', () => {
    expect(truncateForPrompt('x'.repeat(50_000))).toHaveLength(20_000)
  })

  it('leaves short content untouched', () => {
    expect(truncateForPrompt('short')).toBe('short')
  })
})
