# Plan: Shipping-Event Smart Alerts

## Goal recap

Build a conditional alert engine that monitors developer timelines and indexes, triggering email or dashboard notifications based on shipping events (new repos, product launches, specific social keywords).

## Why this is a valuable addition

1. **Perfect Sourcing Timing**: Reaching out to a developer right after they ship a major project or announce they are exploring options drastically increases response rates.
2. **Eliminates Manual Monitoring**: Recruiters don't have to reload profiles daily. The background event-watcher handles the monitoring automatically.
3. **High Email Engagement**: Highly contextual alert emails are opened, read, and acted upon, ensuring long-term product stickiness.

## Phases

### Phase 1: Database Migration
- Add `triggerConditions` and `deliveryChannel` to the `alerts` table.
- Create migrations and sync local database configurations.

### Phase 2: Alert Matcher Engine (`src/lib/alerts/matcher.ts`)
- Implement evaluation logic that takes a list of `TimelineEvent` records and tests them against the JSON `triggerConditions`.
  - Condition: `new_repo` -> Assert event is a commit/push representing a new repository.
  - Condition: `minStars` -> Check if repository has stars > threshold.
  - Condition: `keyword_match` -> Match event description or tags against condition keywords array.
- Write unit tests for the matcher.

### Phase 3: Cron Worker & Dispatcher (`src/lib/alerts/worker.ts`)
- Set up a cron-triggered handler.
- For each active alert:
  - Query DB for new matching builders or timeline activities.
  - Compose a HTML digest.
  - Send the email via Resend / Nodemailer API.
  - Mark `lastTriggeredAt = Date.now()`.

### Phase 4: Alert Settings Dashboard UI
- Build the "Smart Alerts Manager" route `/dashboard/alerts`.
- Design the conditional creation form:
  - Dropdowns for event types.
  - Input tags for target technologies.
  - Slider controls for stars/followers thresholds.
- Render the past trigger logs grid showing what events fired the alerts.

### Phase 5: Verification & Safety
- Test email generation locally using a mail sandbox tool (like Mailtrap).
- Verify that rate-limiting handles thousands of alerts sequentially without blocking system memory.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **API quota exhaustion from frequent scanning** | High | Medium | Do not query external APIs live inside the alert loop. The alert worker should ONLY scan our local `builders` database and cache tables, which are already populated by user searches and background indexers. |
| **Email spam folders classification** | Medium | High | Send consolidated digests (once per day or once per week) rather than triggering an email immediately on every single match. |

## Rollback plan

- Keep the alert dispatcher separate. Turn off the cron execution loop using `ENABLE_ALERTS_CRON=false` in the env if mail configurations fail.
