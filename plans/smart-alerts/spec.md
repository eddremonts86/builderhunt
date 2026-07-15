# Feature: Shipping-Event Smart Alerts

## Problem

Traditional job alerts are static and noisy (e.g. sending a daily list of developers who added "React" to their bios). Releasing recruitment campaigns based on generic tags results in poor timing because the recruiter doesn't know when the candidate is active, exploring, or launching.

Hiring managers need proactive notifications based on **real technical milestones** (e.g. a high-impact developer starting a new Rust library, or a candidate they watch launching on Product Hunt).

## Goal

Redesign the Alerts system (`alerts` table) into a dynamic event-driven trigger system ("Smart Alerts"). Users can configure alerts triggered by specific builder actions:
- A builder with a score > 80 pushes a new project.
- A tracked developer begins committing to a specific topic area (e.g., "WebAssembly" or "Cryptography").
- An indexed builder posts on Bluesky using indicators of project transitions (e.g. hashtag `#buildinpublic` or words like "new project", "looking for collaborators").

## Non-goals

- **No instant push notifications via SMS.** Senders receive daily or weekly email digests, or can view triggers in the dashboard notifications tray.
- **No active developer tracking without public consent.** Sprints and alerts only scan public API feeds.

## User stories

1. **As a recruiter**, I want to create an alert: "Email me if any developer with >100 stars on GitHub pushes a new repository tagged with `#machine-learning`".
2. **As a founder**, I want to watch a candidate's profile and receive an alert if they launch a new product on Product Hunt.
3. **As a user**, I want to see a history of "Triggered Alerts" in my dashboard, letting me inspect the exact commit or post that fired the notification.

## Technical architecture

### 1. Database Schema
We update the existing `alerts` table to support conditional JSON rules:

```ts
// Schema update columns:
export const alerts = pgTable('alerts', {
  // ... existing fields ...
  triggerConditions: jsonb('trigger_conditions').$type<{
    eventType: 'new_repo' | 'new_product' | 'keyword_match' | 'any_activity'
    minStars?: number
    minFollowers?: number
    keywords?: string[]
    builderId?: string // if watching a specific candidate
  }>().notNull(),
  deliveryChannel: text('delivery_channel').default('email'), // email | dashboard
})
```

### 2. Cron Trigger Worker (`src/lib/alerts/worker.ts`)
- Run a scheduled job (e.g. hourly or daily) using standard Cron queues.
- **Step 1**: Load active alerts from the database.
- **Step 2**: For each alert:
  - If it's a profile watch (`builderId` is set): check the builder's recent timeline events since `lastTriggeredAt`.
  - If it's a global filter watch (e.g. new repo matching keywords): search our database for recently indexed builders and projects matching the criteria.
- **Step 3**: If matches are found, group them, generate a digest, and dispatch an email using a transport library (like Resend or Nodemailer).
- **Step 4**: Update `lastTriggeredAt = Date.now()`.

## UX integration

- Create a specialized Alert Form modal inside `src/routes/_dashboard/dashboard/index.tsx`.
- Use a conditional visual form:
  - *Dropdown*: "Notify me when..." (Options: "A developer launches a new repo", "A watched builder ships a product", "A candidate posts about looking for roles").
  - *Filters*: "Located in...", "With at least [number] stars", "Using tech...".
- **Trigger Logs View**: Add an inbox-style list showing past triggered events, linking directly to the builder profiles.

## Success metrics

- **Recruiter Response Time**: Recruiters contact builders within 24 hours of them starting a new project or showing interest, increasing engagement.
- **High Retention**: Recruiters open smart alert emails at a rate >60% (compared to <20% for traditional job boards) because notifications are high-signal and timely.
