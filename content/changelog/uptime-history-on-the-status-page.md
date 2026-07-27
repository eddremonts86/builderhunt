---
title: Uptime history on the public status page
slug: uptime-history-on-the-status-page
date: 2026-07-25
tags: [feature]
---

[/status](/status) used to answer one question: is BuilderHunt up right now. It
now answers the more useful one: has it been.

A snapshot job records a per-component health check on an interval and prunes
anything older than 90 days, and the page computes uptime from those real
snapshots rather than from a hand-maintained number. Incidents are published
alongside it with their timeline — investigating, identified, monitoring,
resolved — and severity.

The rolling window is 90 days because that is how long we keep the snapshots. A
"99.9% uptime" badge with no window behind it is a decoration, and we would
rather show a short honest history than a long invented one.
