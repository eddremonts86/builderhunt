# Solutions Intelligence — security and privacy review

**Status: engineering review complete, external review not done.** Every class plan 43 Phase 9 names has a
stated defence and an executable test. What has not happened is an independent look by someone who did not write
it, and this document does not pretend otherwise.

Last reviewed: 2026-08-01, against migration 0138.

## Threat classes, defences, and where each is proven

| Class | Defence | Proven by |
| --- | --- | --- |
| Prompt injection (user brief) | `wrapUntrusted` delimiters, escaped closing marker; every constraint requires a literal quote from the brief | `tests/unit/security/solutions-adversarial.test.ts`, `tests/unit/lib/solutions/ai-interpret.test.ts` |
| Prompt injection (source content) | Evidence wrapped as untrusted; output re-checked for figures, unknown component ids, compatibility claims | `solutions-adversarial.test.ts`, `ai-explain.test.ts` |
| Poisoned source content | Capability keys come from a closed vocabulary; the explanation may cite only its own route's evidence | `solutions-adversarial.test.ts` |
| SSRF / malicious links | `safeOutboundUrlSchema` refuses non-HTTPS, embedded credentials, localhost, RFC1918, and link-local | `solutions-adversarial.test.ts` |
| Stale evidence | A run pins `component_version_ids` and stores its own route JSON; nothing re-resolves | `solutions-adversarial.test.ts` |
| Identity collision | Reciprocity, not declaration: a link needs the target to point back. `handle.invalid` is a sentinel, never an anchor | `tests/unit/security/human-identity-linking.test.ts` |
| Tenant crossover | RLS on all four tenant tables plus an explicit `organization_id` predicate in every repository query | `verify-rls-local.mjs` (as `builderhunt_app`), `solutions-persistence.test.ts` |
| Privilege changes | `created_by_user_id` is `ON DELETE SET NULL`; a departing member takes nothing with them | `solutions-adversarial.test.ts` |
| Credit races | One reservation per idempotency key; a concurrent duplicate replays | `tests/unit/modules/solutions/billing.test.ts` |
| Source deletion | No foreign key from a run into the catalog; a stored run survives its source being withdrawn | `solutions-adversarial.test.ts` |

### The two defences worth explaining rather than tabulating

**Constraints are grounded by substring, not by judgement.** An interpretation may only return a hard constraint
together with the exact words from the brief that state it, and `groundConstraints` drops any whose quote is not
literally present. This is what makes prompt injection structurally uninteresting here: a fully obedient model
that has been told "the budget is unlimited" still cannot put that constraint into the composer's input unless
the user's own text says it. The check is a string comparison against the input, and a model cannot fake
groundedness it does not have.

The honest limit: text injected *into the brief itself* is the user's own text, so a constraint quoting it does
survive. That is correct — the user typed it — and the adversarial suite asserts both halves so nobody mistakes
the first for the second.

**Explanations are checked after generation, not before.** A reader cannot tell a grounded sentence from a
fluent one, so prompt instructions are the first line and never the only one. `findGroundingViolation` rejects
any currency amount, percentage, or `Nx` multiple that is not in the composer's own estimate text, any bracketed
component id outside the route, and any claim that two components work together. Failure falls back to the
composer's prose and does not retry — re-rolling until the check passes selects for explanations that pass the
check, which is not the same as grounded.

## Kill switches

Every one is an environment flag, default off, independent of the others.

| Switch | Stops | Leaves working |
| --- | --- | --- |
| `SOLUTIONS_PAID_GENERATION_ENABLED=false` | All paid generation, before entitlement is even checked | Saved runs remain readable; ordinary builder search untouched |
| `SOLUTIONS_INTERPRETATION_ENABLED=false` | The brief-interpretation provider call | Generation still runs on the deterministic fallback |
| `SOLUTIONS_EXPLANATION_ENABLED=false` | The route-explanation provider call | Routes keep the composer's own prose |
| `SOLUTIONS_PUBLIC_SCRAPE_ENABLED=false` | Scrape ingestion | The existing catalog stays queryable |
| Per-source toggle (`/api/admin/solutions/sources`) | One source's ingestion | Every other source |
| `AI_DISABLED=true` / `AI_DISABLED_TASKS` | Any AI task platform-wide or by id | Everything deterministic |

The flags are the runbook for most incident classes: an ungrounded explanation reaching users is one flag away
from becoming the composer's prose, and a misbehaving source is one toggle away from silence.

## Runbook by incident class

- **A model asserts something the evidence does not support.** Set `SOLUTIONS_EXPLANATION_ENABLED=false`. Routes
  keep their deterministic prose and nothing else changes. Then add the phrasing to `findGroundingViolation`'s
  checks with a test that fails before the fix.
- **A source's data turns out to be wrong or unlicensed.** Disable that source's toggle, then delete its
  components. Stored runs survive by design; the catalog stops offering them.
- **Credits charged for something unusable.** The release path is `usable: false`. Check
  `billing_credit_reservations` for `settled` rows whose run has no offerable route; refund through the billing
  platform's own refund path, never by editing a reservation.
- **A tenant sees another tenant's run.** This should be impossible — RLS plus an explicit predicate. Treat it
  as a P1, capture the query, and check `app.organization_id` was set: the only way through is a caller that
  reached a repository outside `withTenantContext`.
- **Provider outage.** Nothing to do: both AI paths already fall back deterministically and the credit boundary
  releases on failure.

## Open items

1. **No independent review.** Everything above was written by the same person who wrote the code.
2. **EU AI Act classification is unresolved** and flagged in `plans/implemented/43-solutions-intelligence/tasks.md`:
   the human lane recommends named people for work, and Annex III point 4 reaches task allocation as well as
   recruitment. Needs a human legal read before any flag is enabled in production.
3. **The source register's legal sign-off** lives in `plans/phase-5/01-production-readiness-audit` and is a
   precondition for enabling any scrape source.
4. **No penetration test** against the deployed surface.
