---
title: The pricing page promised three sourcing sprints and the code allowed ten
slug: sprint-allowance-said-three-allowed-ten
date: 2026-07-27
tags: [bugfix]
---

A number on [/pricing](/pricing) did not match what the product enforced, in two
directions at once.

Pro Max was advertised as "AI sourcing sprints (up to 3)". `POST /api/sprints`
allowed ten, because the sprint allowance was keyed by the older three-tier plan
type and Pro Max fell through to Team's row. Pro was the mirror image: three
concurrent sprints were enforced and available, and neither the plan card nor the
feature comparison table mentioned them at all.

Nobody was under-served — in both cases the code was more generous than the copy —
and no allowance changed. What changed is that the allowance now has one
definition, with an explicit row per tier, and every place that states it derives
its wording from that definition instead of repeating the number by hand. There
were four such places and two of them had drifted.

A test asserts the advertised number and the enforced number agree for every
tier, so this fails a build rather than a customer's expectations.

Current allowance: Free none, Pro three, Pro Max ten, Team ten concurrent
sprints. Paused and completed sprints never count.
