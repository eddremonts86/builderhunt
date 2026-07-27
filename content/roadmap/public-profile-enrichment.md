---
title: Public profile enrichment, on a canary
slug: public-profile-enrichment
status: in_progress
category: infrastructure
ship_estimate: Q4 2026
order: 30
---

Connector-based collection of additional public evidence for a profile, with a review workflow, per-source registers, retention limits and subject-initiated processing restrictions that cascade across every organization. The code is complete and deliberately dark: it deploys disabled, then runs a seven-day observation canary before anyone approves switching it on. Enrichment touches other people's data, so slow is the point.
