# Personalized invitations — verification evidence

Closing evidence for [`plans/implemented/59-personalized-invitations`](../../plans/implemented/59-personalized-invitations/tasks.md),
recorded 2026-08-11 on commit `8c73b0f03`.

## What was NOT done, first

The plan's last task asks for a **human pass through the real local browser** at mobile and desktop
widths, with keyboard and accessibility observations recorded by the person doing it. **That did not
happen.** The task was closed on automated evidence by the maintainer's explicit decision, and this
section exists so nobody later reads a checked box as a human sign-off.

Specifically not covered by anything below:

- **Screen-reader behaviour.** No VoiceOver or NVDA pass. The `aria-live` region in
  `OrganizationInvitationPage.tsx` is asserted to *exist* and to be always mounted; whether it
  *announces* usefully is unverified.
- **Keyboard feel.** Tab order and focus visibility are exercised incidentally by Playwright's
  keyboard interactions, not reviewed by a person.
- **Visual judgement at mobile widths.** Screenshots exist at desktop only, apart from the
  `@mobile-only` cases named below, and nobody has looked at them with an eye to whether the
  invitation card reads well.

## Automated evidence, criterion by criterion

| Acceptance criterion | Covered by | Kind |
|---|---|---|
| Sender picks a reason and sees the card being sent | `tests/e2e/invitation-walkthrough.spec.ts` → "the two-step composer, both steps" | e2e + screenshots 02, 03 |
| Details → Review → Send, and Back preserves values | same spec, same test | e2e + screenshot 04 |
| Invitation appears as pending | `tests/e2e/settings-journeys.spec.ts` → "an admin invites someone and sees the invitation appear as pending" | e2e + screenshot 05 |
| Outbox / dev share link | `tests/e2e/team-accounts.spec.ts` → "A invites B, capturing the dev-mode share link" | e2e |
| Signed-out visit to the link returns through sign-in | `tests/e2e/team-accounts.spec.ts` → "B signs up, is redirected through sign-in when visiting the link signed out" | e2e |
| Recipient reviews the invitation and accepts | `tests/e2e/team-accounts.spec.ts` → "B signs up… and accepts" — asserts the value card, its `data-intent`, the organization name, and the three real builders as "0 or 3, never 1 or 2" with `rel=noopener` links | e2e |
| Organization activation after accept | `tests/e2e/team-accounts.spec.ts` → "A sees B as a member and promotes them to admin" | e2e |
| Onboarding prefill from `suggestedQuery` | `tests/unit/routes/onboarding/search-prefill.test.ts` (6 tests) plus the e2e assertion that accept lands on `/onboarding/search` with the query prefilled | unit + e2e |
| Decline | `tests/e2e/team-accounts.spec.ts` → "a third invitee declines, and the decline is a real outcome rather than a message" | e2e |
| Wrong-account and legacy-null states | `tests/e2e/api/organizations-invitations.spec.ts` (13 tests, including "lists by the session's verified email, not by organization" and the id-existence non-disclosure cases) | e2e |
| Beta-mode control, confirm, stale revision → 409 | `tests/e2e/invitation-walkthrough.spec.ts` → "the beta-mode control renders, confirms, and handles a stale revision" | e2e + screenshots 06-09 |
| Member badge only while beta mode is on | `tests/e2e/invitation-walkthrough.spec.ts` → "the member badge appears only while it is on" | e2e + screenshots 10, 11 |
| Mobile rendering of team settings | `tests/e2e/team-accounts.spec.ts` → "dashboard and team settings render usably on a small viewport @mobile-only" | e2e |
| Seat-race safety | `tests/e2e/team-accounts.spec.ts` → "a concurrent final-seat invite race lets exactly one request through" | e2e |

### A gap this evidence file found

Writing the table above meant checking each claim instead of trusting it, and the Decline row did not
survive that. Two specs referenced `invitation-decline-btn` and **neither pressed it** — one asserted it
was visible, the other that it was absent on an invalid invitation. So the button was known to render
and its outcome had never been exercised: not the `POST …/reject` call, not the declined state, not
whether anything was left behind.

`tests/e2e/team-accounts.spec.ts` now has that test, with a third invitee rather than a reused member,
because re-inviting an existing member to decline exercises a different path than a real recipient's.
It asserts the declined state replaces both buttons and the card, that no membership row exists **in
that team**, and that nothing is left `pending` for a later accept to redeem.

My first version of that test asserted C had no membership rows at all and failed on
`org_personal_…:owner`: sign-up gives every user a personal organization, so "no memberships" is never
true of a signed-up user. Declining means not joining *that* organization, which is what it now checks.

The 409 case is driven for real rather than mocked: the spec moves the beta-mode revision underneath an
already-open page, so the conflict the UI handles is one the database actually produced.

## Screenshots

`tests/artifacts/walkthrough/`, 11 images, produced by `tests/e2e/invitation-walkthrough.spec.ts`:

| File | Shows |
|---|---|
| `01-team-settings-before.png` | team settings before any invitation |
| `02-composer-details.png` | step 1 — details |
| `03-composer-review.png` | step 2 — review, with the card the recipient will see |
| `04-composer-back-preserves-values.png` | Back from review, values intact |
| `05-invitation-pending.png` | the invitation listed as pending |
| `06-beta-mode-disabled.png` | beta mode off |
| `07-beta-mode-confirm-enable.png` | the confirmation step |
| `08-beta-mode-enabled.png` | beta mode on |
| `09-beta-mode-revision-conflict.png` | the 409 a stale revision produces |
| `10-badge-absent-when-off.png` | no member badge while off |
| `11-badge-present-when-on.png` | the badge while on |

They cover the **sender** side, the beta-mode control and the badge. They do not cover the recipient
journey; that evidence is the e2e specs in the table above, not an image.

## Commands

    pnpm test:e2e --workers=11 tests/e2e/invitation-walkthrough.spec.ts    3 passed
    pnpm test:e2e --workers=11 tests/e2e/team-accounts.spec.ts           11 passed
    pnpm ci:local                                                          REAL_CI_EXIT=0
      34/34 steps, "Every step that ran passed", 0 FAIL lines
      459 unit test files (6,543 tests), 996 e2e passed / 10 skipped

The 10 skipped e2e tests are the PgBouncer compatibility spec (8), which skips without pooler
credentials by design, plus 2 pre-existing skips.

## Related: what is deliberately absent from the product

Scheduling capability secrets are minted at send time and only their hash is persisted, so there is no
resend for a scheduling link — that is a design decision, not a gap. Adding one would be a design
change. See [`docs/operations/deploy-runbook.md`](./deploy-runbook.md) for the release-time context.
