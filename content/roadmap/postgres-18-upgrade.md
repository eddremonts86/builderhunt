---
title: Postgres 18
slug: postgres-18-upgrade
status: planned
category: infrastructure
ship_estimate: null
order: 210
---

A planned major-version upgrade of the database, including the pgvector extension the semantic index depends on. Invisible when it goes well, which is the entire goal: rehearsed against a restored copy first, with the migration and role bootstrap order already burned in by a restore drill that caught two real bugs.
