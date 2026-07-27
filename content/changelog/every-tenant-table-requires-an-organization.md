---
title: Every private table now requires an organization
slug: every-tenant-table-requires-an-organization
date: 2026-07-27
tags: [improvement, breaking]
---

This one is invisible in the UI and matters more than anything else we shipped
this week.

BuilderHunt's private data — saved searches, alerts, tracked builders, notes —
moved from a per-user model to a per-organization model months ago, but
`organization_id` stayed *nullable* on those tables through the migration
window. Nullable is the honest state while old rows are still being adopted, and
it is also a permanent invitation to a bug: a query that forgets its tenant
filter returns rows instead of failing.

The column is now `NOT NULL` on every tenant-private table, and the migration
that enforces it adopts leftover rows itself rather than assuming a backfill ran
first. Row-level security was already enabled and forced on those tables, with
separate non-owner database roles for the web app, the auth layer, the
background workers and platform admin. The nullable escape hatch is what was
left.

If you have used BuilderHunt at any point, your data was adopted into your
personal organization automatically. Nothing to do, nothing lost. The reason to
tell you is that "we tightened a constraint you cannot see" is exactly the kind
of work that quietly protects your data, and we would rather show it than claim
a security posture in the abstract.
