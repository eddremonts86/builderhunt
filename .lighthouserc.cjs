/**
 * Lighthouse budget gate (plan: audit-performance-qa).
 *
 * Runs against the production preview `.github/workflows/quality.yml` already
 * starts for the accessibility gate — the same build, the same least-privilege
 * database roles — rather than a dev server, because dev-mode module graphs and
 * unminified assets make every number meaningless.
 *
 * Complements `scripts/check-performance-budgets.mjs`, which bounds the *image*
 * bytes at build time. This bounds what the browser actually experiences.
 *
 * Three runs, median taken: a single Lighthouse pass on a shared CI runner has
 * enough variance to flip a borderline assertion on its own.
 */
module.exports = {
  ci: {
    collect: {
      url: ['http://localhost:3000/'],
      numberOfRuns: 3,
      settings: {
        preset: 'desktop',
        // Mobile throttling on a desktop preset: the emulated device stays
        // desktop-sized (that is the layout the budgets below were measured
        // against) while the network and CPU are held to a slow 4G phone,
        // which is the condition worth defending.
        formFactor: 'mobile',
        screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75 },
        throttlingMethod: 'simulate',
        // Skip the audits that cannot pass against a localhost preview and
        // would otherwise drag the category score down for no signal.
        skipAudits: ['canonical', 'is-on-https', 'redirects-http', 'uses-http2'],
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['error', { maxNumericValue: 200 }],
        'total-byte-weight': ['error', { maxNumericValue: 921600 }],
      },
    },
    upload: { target: 'filesystem', outputDir: './tests/artifacts/lighthouse' },
  },
}
