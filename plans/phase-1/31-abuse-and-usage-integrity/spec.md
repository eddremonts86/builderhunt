# Abuse and Usage Integrity

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md),
> [`team-accounts`](../26-team-accounts/spec.md),
> [`stripe-billing-platform`](../29-stripe-billing-platform/spec.md)
> **Blocks**: nothing (it is a release-gate hardening plan, like the audits)
> **Reality check**: `auth_sessions` already stores `ip_address`/`user_agent`
> (`src/shared/lib/db/schema.ts`), Better Auth exposes session hooks the app already uses
> (`databaseHooks.session.create.before` in `src/shared/lib/auth/better-auth.ts`), seats are
> enforced as accepted-members-plus-invitations against `organization_entitlements.seat_limit`
> (`src/shared/lib/auth/organization-lifecycle.ts`), rate limiting exists
> (`src/shared/lib/rate-limit.ts`), audit exists (`src/shared/lib/security/audit.ts`), and the
> privacy policy already discloses IP/User-Agent logging "for abuse prevention"
> (`src/routes/_landing/legal/privacy.tsx`). This plan adds the missing *usage-integrity* layer on
> top; it does NOT re-implement tenant isolation (owned by `security-and-multitenancy`) or payment
> dispute handling (owned by `stripe-billing-platform`).

## Problem

BuilderHunt monetizes per-seat plans (Pro/Pro Max = 1 seat, Team = 10 seats;
`src/shared/lib/billing-shared.ts`, `src/shared/lib/billing/catalog.ts`) but has no control that
ties a *paid seat* to the number of *distinct humans actually using it*. Today a single Pro login
(seat limit 1) can hold unlimited simultaneous sessions from unlimited devices and IPs, so a company
can pay for one seat and have a whole team work concurrently from different PCs — the exact revenue
leak this plan exists to close. Several adjacent tricks share the same root cause (no per-identity
usage accounting): mass free-account creation, unmetered scraping of the core search value, and
rate-limit evasion by IP rotation.

The core economic value BuilderHunt sells — federated search, profile reveals, exports — is
currently **not metered per seat at all** (only the newer AI credit ledger is; and that ledger is
still `in_progress` and does not cover read-only sourcing). So seat sharing is not merely a login
inconvenience: it hands the entire product to an unbounded number of unpaid users.

## Goal

Add a usage-integrity layer that (1) detects and (2) progressively enforces a realistic relationship
between a paid seat and the humans behind it, without harming legitimate users behind corporate NAT,
VPNs, or shared office IPs. Every control ships behind a global mode flag defaulting to **observe**
(measure first, enforce later), follows the enforcement ladder *observe → warn → step-up reauth →
throttle → block*, and is fully auditable. The plan also closes the free-tier multi-accounting and
core-value-metering gaps that make seat sharing economically rational in the first place.

## Non-goals

- Re-implementing tenant isolation, RLS, `requireTenantPrincipal`, or `can()` — owned by
  `security-and-multitenancy`. This plan consumes those; it does not duplicate them.
- The credit-ledger *integrity* itself — atomic reservation, idempotent grants/refunds, the
  refund/dispute state machine, and payment-instrument fraud — is owned by `stripe-billing-platform`
  and already substantially built (`src/shared/lib/billing/reservations.ts`,
  `repositories/billing-ledger.ts`). This plan does not re-implement it; family G below adds the
  *credit-abuse detection* and per-seat budgeting the ledger does not cover, and *verifies* the
  ledger's invariants hold under the real runtime role.
- Hard biometric device attestation, third-party fraud vendors, or CAPTCHAs on the happy path.
  Anti-automation stays proportionate and progressive.
- Blocking legitimate multi-device use (laptop + phone) or shared corporate egress IPs. False
  positives are treated as a first-class failure mode (see OWASP NAT caveat below).

## Threat taxonomy (research)

> Sourcing note: BuilderHunt's configured research MCPs (firecrawl/exa) were **not available** in
> the environment where this plan was written, so live web-search source counts are not claimed.
> The controls below are grounded in three authoritative, directly-verified references — the OWASP
> Session Management Cheat Sheet, the OWASP Business Logic Security Cheat Sheet, and the Better Auth
> session docs — plus BuilderHunt's own code. Confidence: **High** for A/C/E/G-integrity (verified
> against code + OWASP), **Medium** for B/D/G-velocity thresholds (need production baselines before
> enforcing).

### A. Credential / seat sharing — *primary threat*

- **A1 — Concurrent session sharing.** One paid login used simultaneously from many devices/IPs.
  BuilderHunt currently applies **no** concurrent-session cap, so a 1-seat plan serves an unbounded
  team. OWASP calls this an explicit design decision ("Simultaneous Session Logons"): an app that
  does not allow simultaneous logons must terminate the prior session or ask the user which to keep,
  and should expose an active-session list plus an activity logbook (IP, User-Agent, login time,
  idle time). Source: [OWASP Session Management Cheat Sheet — Simultaneous Session Logons](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#simultaneous-session-logons).
- **A2 — Sequential credential passing.** The same login handed around over time (not simultaneous).
  Detectable via device/geo churn even when concurrency looks normal.
- **A3 — Team-seat over-use.** A Team plan (10 seats) shared by 30 people via 1–2 logins, or beyond
  the 10 accepted members. Seat *count* is enforced (`organization-lifecycle.ts`) but seat *usage*
  is not.

Countermeasure basis — OWASP "Binding the Session ID to Other User Properties" recommends binding a
session to client IP and User-Agent and treating a mid-session change of User-Agent or location as a
strong sharing/hijack signal, **while explicitly warning** that NAT/corporate proxies share IPs and
a skilled actor can spoof the UA — so these signals detect but must not solely block. Better Auth
provides the primitives to act: `listSessions`, `revokeSession`, `revokeOtherSessions`, session
`expiresIn`/`updateAge` (idle) and creation hooks. Sources:
[OWASP — Binding the Session ID to Other User Properties](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#binding-the-session-id-to-other-user-properties),
[Better Auth — Session Management](https://www.better-auth.com/docs/concepts/session-management).

### B. Multi-accounting / Sybil (free-tier abuse)

- **B1** — One human creates N free accounts (each sign-up mints a free personal organization via
  `ensurePersonalOrganization`) to multiply free quotas and avoid paying. Email/password only, with
  **no verification gate**, makes this trivial.
- **B2** — Disposable-domain and plus-addressed emails (`me+1@`, temp-mail) to scale B1.
- **B3** — Sign-up velocity from one device/IP/ASN. A per-IP sign-up cap exists (10/day in
  `better-auth.ts`) but is bypassable via IP rotation and ignores device identity.

### C. Metering / quota evasion

- **C1 — Unmetered core value.** Federated search (`src/lib/search.ts`), profile reveals, and CSV
  export (`/api/export/builders`) consume no per-seat quota, so a shared seat yields unlimited
  sourcing. This is the economic core of the seat-sharing incentive.
- **C2 — Scraping / automation.** Headless browsers or replayed API calls with a copied session
  cookie bulk-extract BuilderHunt's aggregated data — both a cost and a data-egress problem
  (OWASP Bot Management and Anti-Automation).
- **C3 — Rate-limit evasion.** `getRateLimitId` keys on IP (or a UA hash) only
  (`src/shared/lib/rate-limit.ts`), so rotating IPs resets the bucket. Limits should also key on the
  authenticated user, organization, and session.

### D. Payment / billing fraud — *owned by `stripe-billing-platform`, referenced here*

Stolen-card checkout then chargeback, buy-use-refund gaming, proration/promo abuse. The Stripe plan
already scopes the reserve-before-spend ledger, refund-revokes-credit, dispute-freezes-entitlement,
one-customer/one-subscription-per-org, and promo limits. This plan adds only **first-purchase
velocity signals** into the shared signal store and defers all money handling to that plan.

### E. Tenant-boundary / data-theft abuse — *owned by `security-and-multitenancy`, referenced here*

Cross-tenant reads, spoofed org IDs, stale-session-after-removal, IDOR/enumeration. Enforced by RLS
+ `requireTenantPrincipal` + `can()`. This plan adds *detection* (surfacing repeated denied
cross-tenant attempts as abuse signals) but changes no isolation logic.

### F. Outbound-feature abuse

Using the outreach generator / Resend email path to spam, or harvesting PII at scale. Mitigated by
per-seat outbound caps here plus the existing subject processing-restriction controls
(`legal-and-compliance`, `claimable-profiles`).

### G. Credit / usage-metering abuse (premium features)

BuilderHunt meters premium features through **two** systems, and both can be gamed:

1. **AI daily budget** (live): per-user, per-task, per-UTC-day call-count allowances
   (`src/shared/lib/ai/budget.ts` `checkAndConsumeBudget`/`decideBudget`; tier allowances in
   `src/shared/lib/ai/tasks.ts`). This is a *count*, not money.
2. **Monetary credit ledger** (`stripe-billing-platform`, already substantially built —
   `src/shared/lib/billing/reservations.ts`, `src/shared/lib/repositories/billing-ledger.ts`,
   `billing/catalog.ts` `monthlyCredits`): reserve-before-spend grants/reservations/allocations,
   packs, monthly-window grants, auto-recharge, refunds.

The credit ledger already enforces the classic business-logic invariants OWASP calls for — the
allocation walk locks eligible grants `SELECT ... FOR UPDATE` (`lockActiveCreditGrantsByEarliestExpiry`),
consumes earliest-expiry first, never goes negative, and the client cannot widen `maximumUnits` or
duration beyond the server-set reservation. So the *integrity* vectors below (G3/G5/G9/G10) are
mostly **already mitigated in the ledger**; this plan's net-new job is (a) *verifying* those
invariants hold under the real runtime role, and (b) adding the *behavioral/detection* controls
(G1/G2/G4/G6/G7) the ledger does not — per OWASP: "a per-action cap plus a per-account cap plus a
per-source cap (per payment method or per device) gives defense in depth." Source:
[OWASP Business Logic Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html).

| Vector | Owner | Status / net-new work |
| --- | --- | --- |
| **G1 — Allowance/credit farming via multi-accounting.** N free orgs multiply free AI allowances; promo/manual-trial grants farmed by spinning up orgs (`ensurePersonalOrganization`). | this plan (× family B) | Net-new: tie allowance/promo eligibility to a verified-identity + linked-account cluster; cap promo/trial grants per device/payment-fingerprint, not just per org. |
| **G2 — Pooled-credit draining via seat sharing.** Team's 2,100 pooled credits drained by more humans than paid seats (shared login / over-seat). | this plan (× family A) | Net-new: per-seat credit sub-budget in `seat_usage_daily`; `pool_drain` signal when few seats consume a disproportionate share. |
| **G3 — Settlement under-reporting (TOCTOU).** Client settling fewer `actualUnits` than really consumed. | `stripe-billing-platform` | Mostly enforced (reservation is server-set; client cannot widen). Net-new: *verify* `settleReservation` derives `actualUnits` from the real provider response server-side, and a produced-but-unsettled op still consumes its reserved max. |
| **G4 — Retry / refund farming.** Consume good output, then claim failure to reclaim `refundUsage` credits. | this plan (× ledger) | Net-new: refunds must be provider-evidence-based + idempotent per settlement + per-account/day capped; `refund_farming` signal on a high refund-to-settle ratio. |
| **G5 — Grant-window / double-grant timing.** Upgrade/cancel churn or racing `invoice.paid` webhooks to mint extra grants. | `stripe-billing-platform` | Mostly enforced (grants unique by subscription/window/type + idempotent webhook inbox). Net-new: *verify* the unique-window constraint + webhook idempotency under the real role. |
| **G6 — Buy → burn → chargeback.** Buy pack/subscription, immediately spend credits on costly premium work, then dispute/refund. | shared with `stripe-billing-platform` | Partly mitigated (dispute freezes + revokes *unused*, pack velocity caps, Radar/3DS). Net-new: first-purchase / new-payment-method credit-consumption caps + spend-velocity signal into `account_risk`; hold high-cost ops for first-time payers behind step-up. |
| **G7 — Operation-cost arbitrage (margin attack).** Craft input so provider (MiniMax/embeddings) cost exceeds credits charged, or inflate output length. | this plan | Net-new: each op's reserved max covers worst-case provider cost + capped max output tokens (`_meta/ai-policy.md`); monitor realized cost-per-credit margin; `margin_drift` signal when provider cost > credits charged. |
| **G8 — Metering bypass at the entry point.** Hit a provider-backed path that skips `reserveCredits`/`checkAndConsumeBudget`, or force server work billed at the free/local rate. | this plan | Net-new: every provider entry point goes through server-side metering (OWASP "avoid implicit permissions — map every entry point"); a boundary test forbids un-metered provider calls. |
| **G9 — Negative / oversized units.** Negative units, allocation over-consumption, integer edge cases. | `stripe-billing-platform` | Enforced by DB CHECKs (no negative units, no allocation over-consumption, no mixed-org refs). Net-new: *verify* those constraints via a direct-SQL test as the runtime role. |
| **G10 — Idempotency-key replay.** Reuse/forge an idempotency key to double-grant or double-refund. | `stripe-billing-platform` | Enforced (results stored + returned by idempotency key; webhook inbox unique per event). Net-new: *verify* replay returns the cached result (no second grant/refund) and keys are org-scoped. |

The "dishonest user" invariants this plan writes down and tests (OWASP): *a credit unit is consumed
at most once; available balance is never negative; a refund never returns more than was settled and
never for already-consumed value; an included-credit grant is minted at most once per
subscription/window; and a provider-backed operation never runs without a successful reservation or
budget consume.*

## Architecture

All new persistence declares a data class per `_meta/security-policy.md` and
`docs/architecture/data-classification.md`.

| Table | Class | Purpose / key invariants |
| --- | --- | --- |
| `user_devices` | Account subject (`user_id`) | One row per (user, device fingerprint hash). First/last seen, coarse UA family, last IP-ASN + country, trust state (`new`/`trusted`/`flagged`). Fingerprint = salted hash of a first-party device cookie + UA client-hint family; never raw fingerprints or PII. |
| `session_signals` | System operational | Append-only per-session enrichment: device id, IP-ASN, country, and computed flags (new-device, concurrent-distinct-IP, impossible-travel, mid-session-UA-change). No session token; correlate by salted session-id hash only (OWASP logging guidance). |
| `abuse_signals` | System operational | Append-only detected events: `type` (concurrent_sessions, impossible_travel, ua_change, seat_overuse, signup_velocity, linked_account, export_burst, cross_tenant_denied, credit_farming, pool_drain, refund_farming, margin_drift, reserve_leak), `severity`, redacted `details`, `userId`/`organizationId` correlation, `requestId`. Never updated/deleted. |
| `account_risk` | Account subject (`user_id`) | Rolling risk score + current enforcement stage (`observe`/`warned`/`stepup`/`throttled`/`blocked`), reason, decayed over time. One row per user. |
| `seat_usage_daily` | Tenant private (`organization_id`) | Per-(organization, seat/user, UTC day) counters for the scarce core actions (searches, profile reveals, exports, outbound messages) **and premium credit units** (each seat's share of the pooled monthly credit budget, for G2). Enforces a per-seat ceiling so sharing one seat hits a wall quickly. Composite tenant FK + RLS. |

Environment (all optional, fail-open to the safe default so unset config never breaks existing
users, matching the app's `env.ts` gate convention):

- `ABUSE_ENFORCEMENT_MODE` = `observe` (default) | `warn` | `enforce`.
- `SESSION_MAX_CONCURRENT_FREE` / `_PRO` / `_TEAM_PER_SEAT` (defaults chosen to allow laptop+phone).
- `SESSION_IDLE_TIMEOUT_MINUTES`, `SESSION_ABSOLUTE_TIMEOUT_HOURS`.
- `SEAT_DAILY_SEARCHES` / `_REVEALS` / `_EXPORTS` / `_MESSAGES` per tier.
- `CREDIT_SEAT_DAILY_UNITS` per tier (each seat's share of the pooled monthly credit budget — G2).
- `CREDIT_FIRST_PAYER_CAP_UNITS` + `CREDIT_FIRST_PAYER_WINDOW_HOURS` (new-payer consumption cap — G6).
- `CREDIT_REFUND_MAX_PER_DAY` (per-account refund cap — G4).
- `CREDIT_MARGIN_ALERT_RATIO` (provider-cost ÷ credits-charged threshold for `margin_drift` — G7).
- `SIGNUP_REQUIRE_VERIFIED_EMAIL` (bool), `SIGNUP_BLOCK_DISPOSABLE_EMAILS` (bool).
- `PROMO_GRANT_MAX_PER_CLUSTER` (promo/trial grants per device/payment/identity cluster — G1).
- `ABUSE_ALLOWLIST_ASNS` (comma list of trusted corporate egress ASNs to suppress IP-churn signals).

Enforcement ladder (applied by a single `resolveEnforcement(userId)` policy, never ad hoc):
`observe` (log signal only) → `warn` (in-app banner + email: "we noticed this account signed in from
N devices") → `stepup` (require password re-auth / verified-email challenge on the next sensitive
action) → `throttle` (tighten per-seat rate limits) → `block` (revoke extra sessions, present a
seat-upgrade upsell). A single weak signal (shared IP alone) never escalates past `warn`; escalation
requires corroborating signals (e.g. distinct devices **and** impossible travel **and** volume) to
respect the OWASP NAT/proxy caveat.

## Data shapes (illustrative)

```ts
// src/shared/lib/abuse/signals.ts
export type AbuseSignalType =
  | 'concurrent_sessions' | 'impossible_travel' | 'ua_change' | 'seat_overuse'
  | 'signup_velocity' | 'linked_account' | 'export_burst' | 'cross_tenant_denied'
  // family G — credit / premium-feature abuse
  | 'credit_farming' | 'pool_drain' | 'refund_farming' | 'margin_drift' | 'reserve_leak'

export interface AbuseSignal {
  type: AbuseSignalType
  severity: 'low' | 'medium' | 'high'
  userId: string | null
  organizationId: string | null
  requestId: string
  details: Record<string, unknown> // redacted via redactLogValue before persist
}

// src/shared/lib/abuse/enforcement.ts
export type EnforcementStage = 'observe' | 'warned' | 'stepup' | 'throttled' | 'blocked'
export interface EnforcementDecision { stage: EnforcementStage; reasons: AbuseSignalType[] }
```

## UX integration

- **`/settings/security`** (new dashboard route): "Active sessions" list (device family, location,
  last active, current-session badge) with "Sign out" per session and "Sign out everywhere else"
  (Better Auth `listSessions`/`revokeSession`/`revokeOtherSessions`), plus a recent-activity logbook.
  This is both a legitimate account-security feature and the primary sharing deterrent.
- **Warn stage banner** in `_dashboard` shell explaining the detected pattern and linking to
  upgrade/seat docs — framed as fairness, not accusation.
- **Platform-admin abuse console** (`/admin/abuse`): `abuse_signals` feed, linked-account clusters
  (shared device/IP/ASN), per-account risk + stage, and manual actions (clear, warn, force step-up,
  block) — all audited via `emitSecurityAudit`.
- **Pricing/FAQ copy** (`src/routes/_landing/pricing.tsx`) clarifies the seat/fair-use policy so
  enforcement is expected, not surprising.

## Success metrics

- Observe window produces a real baseline: median distinct devices/IPs per active seat per tier.
- Concurrent-session cap reduces >Nx-over-seat accounts to within policy without raising verified
  legitimate-user support tickets above an agreed threshold.
- Free-tier sign-ups from disposable domains / same-device bursts drop measurably after B controls.
- Zero false-positive blocks for allowlisted corporate ASNs in the enforce phase (tracked via
  `abuse_signals` + support tags).
- No regression in `pnpm test:rls:local` / `pnpm test:api-isolation:local` (new tables isolated).

## Resolved edge cases

- **Corporate NAT / shared office IP**: many users, one IP is *normal*. IP-only signals are
  suppressed for `ABUSE_ALLOWLIST_ASNS` and never escalate alone (OWASP caveat).
- **Legitimate multi-device**: the per-user concurrency cap is ≥2 for paid tiers (laptop + phone),
  and "one-in-one-out" revocation is the default before hard blocking.
- **VPN / travel**: impossible-travel needs a physically-impossible speed between two IPs within a
  short window, and still only contributes to escalation alongside other signals.
- **Team pooled seats**: Team enforces *per-seat* daily ceilings and per-seat concurrency, so 10
  seats genuinely serve up to 10 concurrent humans, not 30 sharing 2 logins.
- **Break-glass**: `ABUSE_ENFORCEMENT_MODE=observe` fully disables enforcement instantly (kill
  switch) while still collecting signals; `enforce` can be rolled back per-stage.
- **Privacy/legal**: device fingerprinting is disclosed in the privacy policy and consent surface
  (coordinated with `legal-and-compliance`); only salted hashes and coarse UA families are stored,
  never raw fingerprints, exact geolocation, or full IPs beyond the existing 30-day server-log scope.

## Sources

1. [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
   — simultaneous logons, binding session to IP/UA, anomaly detection, idle/absolute timeouts,
   salted-hash session logging, NAT/proxy false-positive caveat.
2. [Better Auth — Session Management](https://www.better-auth.com/docs/concepts/session-management)
   — `listSessions`/`revokeSession`/`revokeOtherSessions`, session creation hooks, `expiresIn`
   (idle) and freshness controls; `ipAddress`/`userAgent` already on the session table.
3. BuilderHunt code (verified): `src/shared/lib/auth/better-auth.ts`, `organization-lifecycle.ts`,
   `rate-limit.ts`, `repositories/entitlements.ts`, `db/schema.ts` (`auth_sessions`,
   `organization_entitlements`), `security/audit.ts`, `_meta/security-policy.md`.
4. [OWASP Business Logic Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html)
   — primary source for family G: re-derive value server-side, explicit state machines, race
   conditions (TOCTOU), value-dispensing abuse, per-action + per-account + per-source caps, and
   anomaly detection. Underlying weaknesses:
   [CWE-840 Business Logic Errors](https://cwe.mitre.org/data/definitions/840.html),
   [CWE-841 Improper Enforcement of Behavioral Workflow](https://cwe.mitre.org/data/definitions/841.html),
   [CWE-367 TOCTOU Race Condition](https://cwe.mitre.org/data/definitions/367.html).
5. BuilderHunt billing code (verified already built): `src/shared/lib/billing/reservations.ts`
   (atomic `SELECT ... FOR UPDATE` reservation via `lockActiveCreditGrantsByEarliestExpiry`),
   `repositories/billing-ledger.ts`, `billing/catalog.ts` (`monthlyCredits`), `ai/budget.ts`
   (`decideBudget`/`checkAndConsumeBudget`).
6. OWASP cross-references for adjacent vectors:
   [Bot Management and Anti-Automation](https://cheatsheetseries.owasp.org/cheatsheets/Bot_Management_and_Anti-Automation_Cheat_Sheet.html),
   [Abuse Case](https://cheatsheetseries.owasp.org/cheatsheets/Abuse_Case_Cheat_Sheet.html).

## Methodology

Investigated the app's real auth/session/billing/rate-limit/audit surfaces (including the built
credit ledger in `src/shared/lib/billing/`), mapped them against the OWASP Session Management,
Business Logic Security, and abuse-case guidance and the Better Auth session API, and organized every
known cheat for a per-seat, credit-metered B2B SaaS into seven threat families (A–G). D, E, and the
credit-ledger *integrity* half of G are delegated to existing plans; A, B, C, F and the credit-abuse
*detection* half of G are the net-new scope here.
