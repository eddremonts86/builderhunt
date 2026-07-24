# Wave 1 — Task 4: External-service boundaries (corrected brief)

> **Status:** `pending` — corrected brief for `docs/superpowers/plans/2026-07-23-exhaustive-local-e2e.md` §Wave 1 Task 4. Replace the original task 4 with this one when implementation starts.
> **Depends on:** Wave 1 Tasks 1–3 (`e2e/harness/{env,database,cache,ids}.ts` + `isolation.spec.ts` + `principals`/`organizations`/`entitlements`/`auth`/`clock` fixtures + `waitForHydration` + `expectStrictBrowser`). Run the existing `pnpm test:e2e -- e2e/harness/isolation.spec.ts` first to confirm Task 1 is green; this task is the next unit of work.
> **Read-only while Wave 1 Task 1 executes.** This file is preparation only — do not edit any code under `src/` until the parent agent assigns Task 4.

## What the original Task 4 got wrong

The original task 4 listed twenty-plus files, promised to "Create `src/shared/lib/email/outbox.ts`" and "Modify `src/shared/lib/email.ts`" as if the email helper were a directory, and asked for *five* fake modules plus a fakes spec with no test order. It left the Stripe signing seam, the worker-invocation control, and the discovery/AI scenario surface underspecified. It also did not say which env var gates the fakes, how the existing `getBillingProvider()` selection seam is to be reused (the original said "Modify and test the existing `src/shared/lib/billing/stripe-provider.ts` selection seam; do not add a second resolver" — that is the right instinct but the exact integration was vague), and it conflated discovery (which the codebase does not yet have as a module) with the existing `ai/enrichment` and `ai/embeddings` modules.

This corrected brief fixes all of the above:

1. The email seam is owned by `src/shared/lib/email.ts` (a single file, not a directory). The outbox is added there — every existing sender routes through a single dispatcher, and the dispatcher honors `E2E_MODE=true`.
2. The billing seam is the existing `getBillingProvider()` + `resetBillingProviderForTests()` in `src/shared/lib/billing/stripe-provider.ts`. No second resolver. The fake stays the same `FakeBillingProvider`; "named scenarios" are accepted via `E2E_BILLING_SCENARIO` env *and* via the existing `scenario` parameter on every create call (no new parameter shape).
3. The webhook seam is the existing `receiveStripeWebhook()` in `src/shared/lib/billing/webhook-inbox.ts` — it already accepts a list of signing secrets, so the test-only secret just gets passed in. The Stripe SDK's `Stripe.webhooks.generateTestHeaderString()` produces signatures that the existing production verifier accepts.
4. "Discovery" is mapped to the actual external boundaries that exist today: `src/shared/lib/ai/embeddings.ts` (embedding HTTP), `src/shared/lib/ai/enrichment.ts` (call into the `profile-enrich` AI task), `src/shared/lib/ai/tasks.ts` (server-side AI task router), and the `src/routes/api/ai/*` routes that proxy them. No new module is added; the fake is a per-process stub installed at module load under `E2E_MODE=true`.
5. The egress guard is a single shim around `globalThis.fetch` invoked once in `e2e/harness/fakes/egress.ts`, which throws on any third-party URL the allowlist does not cover. Production code never imports it.
6. Test order is enforced: RED unit tests first, then RED E2E tests, then GREEN, then refactor. Each step has a single verifiable command.

## Cross-cutting invariants (must hold across every sub-task)

- **Gating.** Every fake is gated by `E2E_MODE === 'true'`. The dispatcher refuses to install the fake — and the egress shim refuses to attach — when `E2E_MODE !== 'true'`. A unit test must prove that a non-`E2E_MODE` process cannot reach the fake control surface (using `process.env` mutation followed by an import in a child process, since the singletons otherwise memoize).
- **Egress.** The only third-party hosts allowed in E2E are `localhost`, `127.0.0.1`, and the worker's own Postgres host. Any other host — `api.resend.com`, `api.minimax.io`, `api.stripe.com`, anything — must throw `EgressBlockedError` from the shim. The `e2e/harness/fakes/egress.spec.ts` proves the shim blocks live URLs by attempting `fetch('https://api.resend.com/emails')` under `E2E_MODE=true` and asserting the throw.
- **Isolation.** Fakes are installed once per worker process, not per test. Cleanup is `dropNamespace`-style: the outbox is emptied, the billing scenario is reset to `success`, the webhook signing secret is restored to the env value, and the egress shim is detached. The harness's existing `e2e/harness/cache.ts` model is the reference.
- **No production change.** Every modification to `src/shared/lib/email.ts`, `src/shared/lib/billing/stripe-provider.ts`, and `src/shared/lib/billing/webhook-inbox.ts` must be test-only — gated by `E2E_MODE` or by the existing internal-test exports. The non-`E2E_MODE` codepath must be byte-identical to today's behavior (no behavioral change shipped under the cover of "test infra").
- **Unrelated changes stay untouched.** The pre-existing Drizzle migration files (`drizzle/0032_chief_captain_stacy.sql`, `drizzle/0033_billing_risk_rls_grants.sql`, `drizzle/meta/0032_snapshot.json`, `drizzle/meta/0033_snapshot.json`), the unrelated `src/shared/lib/billing/{risk,risk.test,auto-recharge,auto-recharge.test,packs,packs.test}.ts` edits, `src/routes/api/admin/billing/risk-exceptions.ts`, `src/shared/lib/repositories/billing-risk.ts`, and `src/shared/lib/db/schema.ts` are out of scope. `git status --short` must not list them as modified after this task.

## Files to create

| Path | Purpose |
|------|---------|
| `e2e/harness/fakes/email.ts` | In-process email outbox (singleton per worker). Replaces `sendOrganizationInvitationEmail` / `sendClaimEmail` / `sendResetPasswordEmail` / `sendAlertDigestEmail` / `sendDeletionScheduledEmail` / `sendDeletionCompletedEmail` / `sendExportReadyEmail` when installed. |
| `e2e/harness/fakes/email.spec.ts` | Unit tests: install, second-install rejection, multi-send capture, scenario timing, `RESEND_API_KEY` non-presence under `E2E_MODE=true`. |
| `e2e/harness/fakes/billing.ts` | Named-scenario selector. Reads `E2E_BILLING_SCENARIO` (`success` default; `sca_required`/`decline`/`timeout`/`delayed`/`out_of_order` allowed) and exposes a hook that the call site already passes through. |
| `e2e/harness/fakes/billing.spec.ts` | Unit tests: scenario propagation, idempotency-key reuse under `E2E_MODE`, default-success in non-`E2E_MODE`, throw with non-`E2E_MODE` on `getBillingProvider` returning the unmodified singleton. |
| `e2e/harness/fakes/webhook.ts` | Real Stripe SDK signer + `signStripeWebhook(payload, secret, timestampDelteSec?)` and a `postWebhook({ baseUrl, payload, secret, headers })` helper. |
| `e2e/harness/fakes/webhook.spec.ts` | Unit tests: `generateTestHeaderString` round-trip, signature tolerance (`SIGNATURE_TOLERANCE_SECONDS`) edge, missing/empty/malformed signature, dual-secret rotation. |
| `e2e/harness/fakes/discovery.ts` | Stub connector for `src/shared/lib/ai/embeddings.ts` and `src/shared/lib/ai/enrichment.ts` HTTP boundaries. Named scenarios: `success`, `empty`, `malformed`, `hostile`, `timeout`, `rate_limited`, `fallback`. |
| `e2e/harness/fakes/discovery.spec.ts` | Unit tests for each scenario. |
| `e2e/harness/fakes/ai.ts` | Stub for `src/shared/lib/ai/tasks.ts` task router. Scenarios: `success`, `disabled`, `budget_exceeded`, `unsupported`. |
| `e2e/harness/fakes/ai.spec.ts` | Unit tests. |
| `e2e/harness/fakes/egress.ts` | Wraps `globalThis.fetch` with a strict allowlist (`localhost`, `127.0.0.1`, the worker's Postgres host). Throws `EgressBlockedError` for anything else. |
| `e2e/harness/fakes/egress.spec.ts` | Proves the shim blocks `https://api.resend.com/...`, `https://api.stripe.com/...`, `https://api.minimax.io/...`, and DNS-rebinding-style hosts. |
| `e2e/harness/fakes.spec.ts` | End-to-end harness of the fakes: one file that exercises every fake in sequence under a single worker and asserts no live egress. |
| `src/shared/lib/email/outbox.ts` | The outbox itself, exported as a pure module. The dispatcher in `src/shared/lib/email.ts` calls it before the Resend fetch. |
| `src/shared/lib/email/outbox.test.ts` | Vitest unit tests for the outbox (install / capture / reset / thread-safety). |

## Files to modify (test-only seams)

- `src/shared/lib/email.ts` — add a single `dispatchEmail(...)` helper that all existing senders route through. When `E2E_MODE === 'true'`, the dispatcher calls the outbox and returns `{ ok: true, id: 'outbox:<n>' }`; otherwise it preserves the current Resend fetch path verbatim. **No API surface change for the existing senders.** The dispatcher's *visibility* is `export` only under `E2E_MODE` so production bundles cannot reach it.
- `src/shared/lib/billing/stripe-provider.ts` — extend `getBillingProvider()` to accept the env var `E2E_BILLING_SCENARIO` when `E2E_MODE === 'true'`. Internally the singleton is reset and replaced with a `FakeBillingProvider` whose `scenario` field is fixed at the requested value (the existing `scenario` parameter on every create call still wins — the env var is the *default*). The existing `resetBillingProviderForTests()` keeps working. The non-`E2E_MODE` codepath is byte-identical.
- `src/shared/lib/billing/webhook-inbox.ts` — no functional change. `receiveStripeWebhook()` already accepts a `signingSecrets` argument; the only addition is a typed `__e2eSigningSecrets` export that the harness can read from `process.env` (`E2E_STRIPE_WEBHOOK_SECRET`, current/previous), guarded by `E2E_MODE`. The existing `verifySignature(...)` is reused unmodified.
- `src/shared/lib/billing/worker.ts` / `replayBillingWebhookEvent.ts` — these already accept a `retriever` override. The brief does *not* modify them; the harness uses the overrides already present.
- `src/shared/lib/ai/embeddings.ts` — add a one-line override seam: when `E2E_MODE === 'true'` and the env var `E2E_EMBEDDINGS_SCENARIO` is set, return the deterministic stub from `e2e/harness/fakes/discovery.ts`. The production code path is preserved verbatim.
- `src/shared/lib/ai/enrichment.ts` — same pattern (`E2E_ENRICHMENT_SCENARIO`).
- `src/shared/lib/ai/tasks.ts` — same pattern (`E2E_AI_TASK_SCENARIO`).
- `e2e/harness/env.ts` — extend the schema with `E2E_BILLING_SCENARIO`, `E2E_STRIPE_WEBHOOK_SECRET`, `E2E_STRIPE_WEBHOOK_SECRET_PREVIOUS`, `E2E_EMBEDDINGS_SCENARIO`, `E2E_ENRICHMENT_SCENARIO`, `E2E_AI_TASK_SCENARIO`, `E2E_OUTBOX_MODE` (`memory` default). All optional, all `E2E_MODE`-gated.

## Files NOT to touch

- `src/shared/lib/email.ts`'s existing HTML bodies, sender addresses, and `SendResult` shape — unchanged.
- `src/shared/lib/billing/stripe-client.ts` — the lazy singleton stays exactly as it is; the ready signal the readiness check reads is unchanged.
- `src/shared/lib/billing/fake-provider.ts` — the scenario vocabulary is preserved; new scenarios are not added.
- `src/shared/lib/billing/catalog.ts` and `src/shared/lib/billing/catalog-validation.ts` — untouched.
- Any Drizzle migration file (`drizzle/0032_*`, `drizzle/0033_*`, `drizzle/meta/_journal.json`, `src/shared/lib/db/schema.ts`).
- `src/routes/api/webhooks/stripe.ts` — the route handler is reused unchanged; the *test* posts there via the harness's `postWebhook` helper.
- The `e2e/harness/{env,database,cache,ids,isolation.spec}.ts` files added by Task 1.
- `src/shared/lib/billing/{risk,risk.test,auto-recharge,auto-recharge.test,packs,packs.test}.ts` and `src/shared/lib/repositories/billing-risk.ts` — the unrelated Wave 1 changes already in the working tree.

## Strict vertical TDD steps

Run each step in order. Do not move to step N+1 until step N is green.

### Step 1 — RED unit: outbox + email dispatcher (no live Resend)

1. Write `src/shared/lib/email/outbox.test.ts` covering:
   - `installOutbox()` returns the same singleton on second call.
   - `recordOutbox({ to, subject, html })` increments the counter and stores the entry on `globalThis.__emailOutbox`.
   - `resetOutbox()` empties the array.
   - `dispatchEmail(input)` returns `{ ok: true, id: 'outbox:<n>' }` and does NOT call `fetch` (assertion via `vi.spyOn(globalThis, 'fetch')`).
   - `dispatchEmail` is unreachable when `E2E_MODE !== 'true'` (assert via `vi.stubEnv('E2E_MODE', 'false')` + re-import in a child worker).
2. Write `src/shared/lib/email.ts` test additions: `sendClaimEmail` under `E2E_MODE=true` calls `dispatchEmail` and never touches `fetch`. Same for the other six senders.
3. Run `pnpm vitest run src/shared/lib/email/outbox.test.ts src/shared/lib/email.test.ts` — expected RED (module is not yet written).
4. Implement `src/shared/lib/email/outbox.ts` (the module) and add the `dispatchEmail(...)` helper inside `src/shared/lib/email.ts`. Wire every existing sender through the dispatcher.
5. Re-run — expected GREEN.

### Step 2 — RED unit: billing scenario selection seam

1. Write `src/shared/lib/billing/stripe-provider.test.ts` additions:
   - Under `E2E_MODE=true` and `E2E_BILLING_SCENARIO=decline`, `getBillingProvider()` returns a `FakeBillingProvider` whose `createCheckoutSession({ scenario: 'success', ... })` still throws `BillingProviderError('decline')` (the env var is the *default*; per-call wins).
   - Under `E2E_MODE=true` and `E2E_BILLING_SCENARIO=delayed`, `createCheckoutSession` returns `{ status: 'open', ... }` (matching the existing scenario shape).
   - Under `E2E_MODE=false`, `getBillingProvider()` returns the same singleton as today (assertion: `resetBillingProviderForTests()` is the only way to get a fresh instance).
   - Under `E2E_MODE=true` but `E2E_BILLING_SCENARIO` unset, the default behavior is `success`.
2. Run `pnpm vitest run src/shared/lib/billing/stripe-provider.test.ts` — expected RED (the env-var branch is not yet wired).
3. Modify `src/shared/lib/billing/stripe-provider.ts` to consult `E2E_BILLING_SCENARIO` when `E2E_MODE === 'true'`. Reuse the existing `getFakeBillingProviderSingleton()`; pass the env var's value through a new `withDefaultScenario(scenario)` setter on the singleton. The non-`E2E_MODE` path is unchanged.
4. Re-run — expected GREEN. Also run `e2e/harness/fakes/billing.spec.ts` once it exists.

### Step 3 — RED unit: webhook signer + tolerance

1. Write `e2e/harness/fakes/webhook.spec.ts`:
   - `signStripeWebhook(payload, secret)` produces a header that `Stripe.webhooks.constructEvent(rawBody, header, secret, SIGNATURE_TOLERANCE_SECONDS)` accepts.
   - Stale timestamp (now − `SIGNATURE_TOLERANCE_SECONDS` − 1) is rejected.
   - Dual-secret rotation: header signed with the *previous* secret is accepted when both `STRIPE_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET_PREVIOUS` are in the env.
   - Malformed payload is rejected.
   - Empty secret is rejected.
2. Run `pnpm vitest run e2e/harness/fakes/webhook.spec.ts` — expected RED.
3. Implement `e2e/harness/fakes/webhook.ts`. Use the Stripe SDK's `Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp, tolerance })` — *do not* reimplement HMAC.
4. Re-run — expected GREEN.

### Step 4 — RED unit: discovery/AI stubs (no live HTTP)

1. Write `e2e/harness/fakes/discovery.spec.ts` and `e2e/harness/fakes/ai.spec.ts`:
   - Each scenario returns the documented shape.
   - `malformed` returns a payload that fails the existing zod schema in `src/shared/lib/ai/enrichment.ts`.
   - `timeout` throws after the configured `AI_EMBEDDING_TIMEOUT_MS` (use `vi.useFakeTimers()`).
   - `rate_limited` returns a 429-shaped error.
   - Egress shim blocks `https://api.minimax.io/v1/embeddings` (the real endpoint).
2. Implement `e2e/harness/fakes/discovery.ts` and `e2e/harness/fakes/ai.ts` — pure stubs, no HTTP.
3. Add the one-line `E2E_*_SCENARIO` short-circuit in `src/shared/lib/ai/{embeddings,enrichment,tasks}.ts` and the corresponding tests. Each must demonstrate the production path is unreachable when `E2E_MODE !== 'true'`.

### Step 5 — RED unit: egress shim

1. Write `e2e/harness/fakes/egress.spec.ts`:
   - `installEgressGuard()` overrides `globalThis.fetch` such that `fetch('https://api.resend.com/emails')` throws `EgressBlockedError`.
   - `fetch('http://localhost:3000/api/health')` passes through.
   - `fetch('http://127.0.0.1:5432/...')` is rejected (egress guard does not whitelist DB ports).
   - DNS-rebinding-style host (`attacker.example.com`) is rejected.
   - Uninstall restores the original `fetch`.
2. Implement `e2e/harness/fakes/egress.ts`: a module-level `let originalFetch: typeof fetch | null` and a getter that compares the request URL against the allowlist. The shim is installed exactly once per worker process and refuses to install under `E2E_MODE !== 'true'`.

### Step 6 — RED E2E: fakes under real workers

1. Write `e2e/harness/fakes.spec.ts`:
   - `test('email outbox captures the five critical senders', ...)` — drives a sign-up flow, a forgot-password flow, and an organization-invitation flow; asserts `globalThis.__emailOutbox` has exactly the expected entries with the expected `subject` and `to` fields.
   - `test('billing scenario=sca_required forces incomplete status', ...)` — drives a checkout through the real Vite dev server, asserts the database subscription is `incomplete`, and asserts the response payload is mapped correctly.
   - `test('signed webhook receipt accepts a fresh signature and rejects a stale one', ...)` — POSTs to `/api/webhooks/stripe` with both valid and stale `Stripe-Signature` headers; asserts 200 vs. 400 + the structured `code` field.
   - `test('discovery/AI stubs never hit live networks', ...)` — drives a search query that internally calls embeddings, asserts `EgressBlockedError` is NOT thrown, and the response shape matches the chosen `E2E_EMBEDDINGS_SCENARIO=success`.
   - `test('egress shim blocks a live Resend URL', ...)` — installs the shim, attempts `fetch('https://api.resend.com/emails')`, asserts the throw.
2. Run `pnpm test:e2e -- e2e/harness/fakes.spec.ts` — expected RED.
3. Wire the fakes into `playwright.config.ts` via a new `globalSetup` that installs the egress shim and outbox before any worker boots.
4. Re-run — expected GREEN.

### Step 7 — refactor

1. Move duplicated URL-allowlist logic to a single `e2e/harness/fakes/_allowlist.ts`.
2. Move scenario enum to a single `e2e/harness/fakes/_scenarios.ts`.
3. Confirm `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` all pass.
4. Run `pnpm test:e2e -- e2e/harness/isolation.spec.ts e2e/harness/fakes.spec.ts --repeat-each=2` — expected GREEN.

## Exact commands

```bash
# From /Users/edd/Projects/eddremonts86/builderhunt

# Pre-flight: confirm Task 1 is green.
pnpm test:e2e -- e2e/harness/isolation.spec.ts

# Step 1: RED -> GREEN for email outbox.
pnpm vitest run src/shared/lib/email/outbox.test.ts
pnpm vitest run src/shared/lib/email.test.ts

# Step 2: RED -> GREEN for billing scenarios.
pnpm vitest run src/shared/lib/billing/stripe-provider.test.ts

# Step 3: RED -> GREEN for webhook signer.
pnpm vitest run e2e/harness/fakes/webhook.spec.ts

# Step 4: RED -> GREEN for discovery/AI stubs.
pnpm vitest run e2e/harness/fakes/discovery.spec.ts
pnpm vitest run e2e/harness/fakes/ai.spec.ts

# Step 5: RED -> GREEN for egress shim.
pnpm vitest run e2e/harness/fakes/egress.spec.ts

# Step 6: E2E under two workers.
pnpm test:e2e -- e2e/harness/fakes.spec.ts --workers=2

# Step 7: refactor + full green.
pnpm lint
pnpm type-check
pnpm test
pnpm build
pnpm test:e2e -- e2e/harness/isolation.spec.ts e2e/harness/fakes.spec.ts --workers=2 --repeat-each=2

# Step 8: confirm unrelated changes are untouched.
git status --short \
  | grep -vE '^(.{3}src/shared/lib/email.ts|.{3}src/shared/lib/billing/stripe-provider.ts|.{3}src/shared/lib/billing/webhook-inbox.ts|.{3}src/shared/lib/ai/(embeddings|enrichment|tasks).ts|\?\? (e2e/harness/fakes/|src/shared/lib/email/outbox)|.{3}drizzle/meta/(0032|0033))' \
  | head -20
# Expected: empty (no other changes).
```

## External-egress guard

The single guard is `e2e/harness/fakes/egress.ts`. It is the only module that overrides `globalThis.fetch`. It is installed exactly once per worker process via `playwright.config.ts`'s `globalSetup`. It enforces:

- **Allowlist:**
  - `http://localhost:*`
  - `http://127.0.0.1:*`
  - The worker's Postgres host (read from `DATABASE_MIGRATION_URL` at install time, endpoint-only — not the full URL).
- **Blocklist:**
  - `*.resend.com`, `api.resend.com`
  - `*.stripe.com`, `api.stripe.com`, `*.stripe.network`
  - `*.minimax.io`, `*.openai.com`, `*.anthropic.com`
  - Any non-allowlisted host.
- **Error shape:** `EgressBlockedError { url: string, reason: `host: ${string}` | `port: ${string}` }`. The original `fetch` is preserved and restored on `uninstallEgressGuard()`, which `globalTeardown` calls.

The guard is the **only** place that imports `EgressBlockedError`; production code never sees it. If the guard is not installed and `E2E_MODE === 'true'`, every `fetch` call from `src/shared/lib/email.ts` / `src/shared/lib/ai/*` continues to talk to the real host — and the `e2e/harness/fakes/egress.spec.ts` test itself asserts that without the shim, a default `fetch` to `https://api.resend.com` would succeed (it cannot, because the harness must run against an environment without network egress to those hosts, but the test verifies the shim's *correctness* by attempting the disallowed call inside the shim and asserting the throw).

## Acceptance criteria

- All Vitest specs in this brief pass under `pnpm vitest run`.
- `e2e/harness/fakes.spec.ts` passes under `pnpm test:e2e --workers=2 --repeat-each=2`.
- `e2e/harness/isolation.spec.ts` still passes (no regression in Task 1).
- `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` all pass.
- `pnpm test:e2e:coverage` (the script Task 5 will add) reports 100% of the routes that flow through these fakes as `covered`.
- `git status --short` lists only the files in the "Files to create" and "Files to modify" sections above — no unrelated Drizzle, billing-risk, or auto-recharge changes.
- No new npm dependencies introduced. The Stripe SDK and undici `fetch` are reused; no `node-fetch`, no `axios`, no `nock`.

## Notes for the implementer

- The Stripe SDK is already installed at `stripe@22.3.2` (see `src/shared/lib/billing/stripe-client.ts`). `Stripe.webhooks.generateTestHeaderString` is the only webhooks-related function the harness should call — never roll HMAC by hand.
- The `E2E_BILLING_SCENARIO` env var honors the existing scenario vocabulary (`success`, `sca_required`, `decline`, `timeout`, `delayed`, `out_of_order`). Adding new scenarios is out of scope for this task.
- The outbox stores `{ to, subject, html, sentAt, scenario }` per sender. HTML is stored verbatim — *do not* redact the token link from password-reset or invitation emails inside the outbox itself; the test's redaction is the test's responsibility. This mirrors the existing `devLink` behavior in `src/shared/lib/email.ts`.
- The egress shim must use `Object.defineProperty(globalThis, 'fetch', { value, configurable: true })` so it can be uninstalled cleanly. Replacing `globalThis.fetch` directly may be non-configurable in some Node versions.
- The exact `SIGNATURE_TOLERANCE_SECONDS` constant lives in `src/shared/lib/billing/webhook-inbox.ts` — import it rather than duplicating the literal.
- Do not add `throwOnConsoleError` to the worker server. The browser's `expectStrictBrowser` covers console errors; the E2E fakes do not need to assert against server-side console output.
