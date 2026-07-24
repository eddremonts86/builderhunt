# Stripe API/Webhook Secret Rotation

> Applies once a real Stripe-backed `BillingProvider` exists (see `stripe-incident-response.md`'s
> kill-switch section) — the procedures below are Stripe Dashboard/API operator steps independent of
> that adapter's own code, but there is currently nothing live to rotate against in production.

## What can be rotated, and how each behaves

| Secret | Env var | Overlap window? |
| --- | --- | --- |
| API secret key | `STRIPE_SECRET_KEY` | **None.** Stripe deactivates the old key the moment you roll it in the Dashboard — every in-flight request signed with the old key starts failing immediately. |
| Webhook endpoint signing secret | `STRIPE_WEBHOOK_SECRET` (+ `STRIPE_WEBHOOK_SECRET_PREVIOUS`) | **Yes, deliberately built for it.** `webhook-inbox.ts`'s `verifyWebhookSignature` tries every currently-configured secret in order — current, then previous — so both the old and new endpoint secret verify successfully during a rotation window. |

## Scheduled rotation (no compromise, just hygiene)

1. In the Stripe Dashboard, roll the webhook endpoint's signing secret (**Developers → Webhooks →
   [endpoint] → Roll secret**) — Stripe keeps both the old and new secret valid for a short window.
2. Set `STRIPE_WEBHOOK_SECRET_PREVIOUS` to the OLD secret and `STRIPE_WEBHOOK_SECRET` to the NEW one,
   deploy.
3. Confirm live traffic verifies (check `billing_webhook_events` for new rows with
   `status != 'failed'`, or `operations-metrics.ts`'s webhook backlog/age on `/admin/billing`).
4. Once Stripe's own overlap window has passed (its rotation UI states the exact duration), unset
   `STRIPE_WEBHOOK_SECRET_PREVIOUS` and deploy again — leaving a rotated-out secret configured
   indefinitely is a needless attack surface.
5. For `STRIPE_SECRET_KEY`: since there's no overlap, prepare the new-key deploy FIRST (staged,
   ready to release), THEN roll the key in the Dashboard, THEN release immediately — minimize the
   window where the app is calling Stripe with an already-deactivated key.

## Compromise rotation (a secret leaked)

Treat this as urgent — every minute the old secret remains valid is exposure, not overlap-window
convenience:

1. Immediately roll BOTH `STRIPE_SECRET_KEY` and the webhook signing secret in the Stripe Dashboard,
   regardless of any planned overlap — a leaked key must be killed, not gracefully rotated.
2. Deploy the new secrets as fast as possible. Expect a real outage window here (API key has no
   overlap) — this is the tradeoff of prioritizing containment over availability, which is correct
   for a leak.
3. Once back up, walk "Webhook recovery after an outage" in `stripe-incident-response.md` to drain
   whatever queued during the gap.
4. Audit: pull the Stripe Dashboard's API request log (**Developers → API logs**, filtered to the
   compromised key) for the exposure window and confirm nothing unexpected happened with it before
   it was deactivated.
5. Rotate `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` too if the leak vector could plausibly have exposed it
   (it encrypts every stored raw webhook payload at rest, `billing_webhook_events.payload_encrypted`)
   — this one has no dual-key overlap support today, so rotating it means old encrypted payloads
   become unreadable; only do this if genuinely warranted, and confirm nothing depends on decrypting
   historical payloads first.

## Owner

**Edd Remonts** (confirmed 2026-07-24 — `stripe-launch-register.md`'s "Secret rotation owner" row).
