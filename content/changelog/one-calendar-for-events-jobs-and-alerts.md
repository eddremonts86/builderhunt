---
title: One calendar for interviews, worker runs and alert deliveries
slug: one-calendar-for-events-jobs-and-alerts
date: 2026-07-26
tags: [feature]
---

`/calendar` is new, and it merges three things that used to live in three places
you had to check separately: your scheduled interviews, the background jobs that
run on your behalf, and alert deliveries.

What shipped with it:

- **Recurrence that is expanded on the server**, timezone-correct, with a worker
  that materializes occurrences ahead of time instead of computing them in the
  browser.
- **A private ICS export** and a per-account notification feed, so the calendar
  you already use can subscribe to this one. ICS instants are emitted in UTC —
  an earlier build wrote `TZID` labels against the *server's* clock, which
  quietly shifted every event for anyone not sitting in that timezone.
- **Reminder delivery** through a worker whose ICS output is parsed back and
  verified before it is sent, rather than trusted because we generated it.
- **One shared job-run recorder** for all seven background workers, which is why
  worker activity can appear on a calendar at all.

Availability policies are owner-scoped and versioned, so changing your working
hours cannot retroactively invalidate a slot someone already booked.
