---
title: Work-sample analysis — an AI review of a candidate's public work
slug: work-sample-analysis
date: 2026-07-25
tags: [feature]
---

You can now ask BuilderHunt to read a candidate's public GitHub work and give
you a structured review of it: what the code does, what it suggests about how
they work, and what you would want to ask them about in an interview.

It is scoped on purpose. It reads public repositories only. It produces a
structured output validated against a schema, so it cannot ramble its way into
a hiring recommendation. And it never returns a hire/no-hire verdict — the
domain contracts have an explicit prohibited-output gate for exactly that,
because a model that has read three repositories is not qualified to make that
call and neither is a product that pretends it is.

Analyses are stored per organization, cost credits from your plan's monthly
grant, and are visible to everyone on your team so two people do not pay twice
for the same read.
