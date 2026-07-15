# Tasks: Shipping-Event Smart Alerts

## Phase 1: Database Setup
- [ ] Create migration adding `trigger_conditions` and `delivery_channel` to `alerts`
- [ ] Export updated columns inside `src/shared/lib/db/schema.ts`

## Phase 2: Alert Matcher Utilities
- [ ] Create `src/lib/alerts/matcher.ts`
  - [ ] Implement conditional parsing for `triggerConditions`
  - [ ] Write event filters evaluating matching parameters (stars, keywords)
- [ ] Write matcher unit tests under `tests/alerts/matcher.test.ts`

## Phase 3: Cron Worker & Email Dispatcher
- [ ] Create `src/lib/alerts/worker.ts`
  - [ ] Integrate Resend or Nodemailer client reading `RESEND_API_KEY`
  - [ ] Write cron scheduler querying active alerts (running every 12 hours)
  - [ ] Write HTML template composer for the digest email
  - [ ] Update `lastTriggeredAt` timestamp on successful email send

## Phase 4: UI Dashboard Portal
- [ ] Create routes under `/dashboard/alerts`
  - [ ] Build the Alerts dashboard layout showing active watches
  - [ ] Implement conditional alert creation form wizard
  - [ ] Build trigger logs explorer displaying historical matches

## Phase 5: Verification & Safety
- [ ] Test cron worker using a local mockup scheduler
- [ ] Verify digest composition matches styling design guidelines
