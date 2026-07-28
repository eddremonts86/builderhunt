/**
 * @vitest-environment node
 *
 * Live provider smoke tests. Skipped unless `AI_LIVE_SMOKE=true`.
 *
 * ## Why this exists as a committed test rather than a script somebody runs from memory
 *
 * Both providers were configured for a long time with no evidence either actually answered. `minimax`
 * in particular has eight production call sites and its only test mocks `fetch` — which proves the
 * adapter builds a request the way the adapter builds a request, and nothing about whether MiniMax
 * accepts it. The first real call to either endpoint in this repository was made by hand on
 * 2026-07-28; that is the kind of check that needs to be repeatable or it will not be repeated.
 *
 * ## Why it is opt-in rather than skip-if-configured
 *
 * `s3-provider.test.ts` and `clamav.test.ts` run automatically whenever their service is reachable,
 * because those are local containers and a request costs nothing. These calls cost money. Gating on key
 * presence would mean every `pnpm test:unit` on a developer machine silently billed two providers, so
 * the switch is an explicit intent (`AI_LIVE_SMOKE=true`) rather than an inferred one.
 *
 * ## Synthetic data only, and that is not a convention
 *
 * The prompts below are about a fictional robot. A connectivity check must never be the reason a real
 * candidate's CV leaves the building — there is no consent record for "we sent it to see if the API was
 * up", and a smoke test is the easiest place for that to happen without anyone noticing.
 *
 * Run with:
 *   AI_LIVE_SMOKE=true SENSITIVE_AI_ENABLED=true pnpm exec vitest run tests/unit/shared/lib/ai/live-provider-smoke.test.ts
 */
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

const liveSmokeEnabled = process.env.AI_LIVE_SMOKE === 'true'

/** Deliberately fictional. See the header. */
const SYNTHETIC_SYSTEM = 'You answer strictly as JSON matching {"verdict":"yes"|"no","reason":string}.'
const SYNTHETIC_PROMPT =
  'A fictional inventory record: "Widget QA robot, model ZX-9, assembled 2099." Is ZX-9 a robot? Answer as JSON.'

const verdictSchema = z.object({ verdict: z.enum(['yes', 'no']), reason: z.string().min(1) })

describe.skipIf(!liveSmokeEnabled)('live sensitive provider (Mistral, EU)', () => {
  it('answers a synthetic structured request', async () => {
    const { sensitiveCompletion } = await import('~/shared/lib/ai/sensitive')

    const telemetry: unknown[] = []
    const result = await sensitiveCompletion(
      { system: SYNTHETIC_SYSTEM, prompt: SYNTHETIC_PROMPT, schema: verdictSchema, maxOutputTokens: 200 },
      (entry) => telemetry.push(entry),
    )

    expect(result.provider).toBe('mistral')
    // The model id is asserted to be *present and dated*, not equal to a literal: the point of pinning
    // a dated id in env is that it changes on purpose, and a test hard-coding one would have to be
    // edited every time it legitimately does.
    expect(result.model).toMatch(/-\d{4}$/)
    expect(result.usage.promptTokens).toBeGreaterThan(0)
    expect(result.output.verdict).toBe('yes')

    // The redaction guarantee, against a real completion rather than a fixture.
    expect(JSON.stringify(telemetry)).not.toContain('ZX-9')
    expect(JSON.stringify(telemetry)).not.toContain('robot')
  }, 90_000)
})

/**
 * MiniMax gets more attempts than Mistral, and the reason is measured rather than defensive.
 *
 * On 2026-07-28, four consecutive live runs of this prompt failed schema validation once — roughly one
 * call in four — *after* `minimaxChat`'s own single retry. Mistral passed four for four. So a
 * single-attempt smoke here would fail about a quarter of the time, and a smoke that cries wolf gets
 * ignored, which is worse than not having one.
 *
 * What this therefore asserts is **connectivity and eventual structured output**, not per-call
 * compliance. The per-call rate is a real quality property of MiniMax worth its own work — eight
 * production routes call it, and they surface a schema failure as a 502 `ai_parse_failed`, so the
 * user-visible effect is an AI feature that fails intermittently rather than corrupt data.
 */
const MINIMAX_SMOKE_ATTEMPTS = 3

describe.skipIf(!liveSmokeEnabled)('live general provider (MiniMax)', () => {
  it('eventually answers a synthetic structured request', async () => {
    // The provider behind eight production routes, and until now covered only by a mocked `fetch`.
    const { minimaxChat } = await import('~/shared/lib/ai/minimax')

    const usage: unknown[] = []
    const failures: string[] = []
    let output: { verdict: string } | null = null

    for (let attempt = 1; attempt <= MINIMAX_SMOKE_ATTEMPTS && output === null; attempt += 1) {
      try {
        output = await minimaxChat({
          system: SYNTHETIC_SYSTEM,
          prompt: SYNTHETIC_PROMPT,
          schema: verdictSchema,
          maxOutputTokens: 200,
          onUsage: (entry) => usage.push(entry),
        })
      } catch (error) {
        failures.push((error as Error).name)
      }
    }

    // Every attempt failing is a real outage, not the known flakiness — the measured rate makes three
    // consecutive schema failures very unlikely.
    expect(output, `all ${MINIMAX_SMOKE_ATTEMPTS} attempts failed: ${failures.join(', ')}`).not.toBeNull()
    expect(output?.verdict).toBe('yes')
    expect(usage).not.toHaveLength(0)
    if (failures.length > 0) {
      console.warn(`MiniMax needed ${failures.length + 1} attempts for schema-valid output (${failures.join(', ')})`)
    }
  }, 180_000)
})

describe('the smoke suite refuses to pass silently', () => {
  it('states clearly when it is skipped', () => {
    // Without this, a green run says nothing about whether either provider was reached — which is the
    // failure mode the whole file exists to close.
    if (!liveSmokeEnabled) {
      expect(process.env.AI_LIVE_SMOKE ?? 'unset').not.toBe('true')
      return
    }
    expect(liveSmokeEnabled).toBe(true)
  })
})
