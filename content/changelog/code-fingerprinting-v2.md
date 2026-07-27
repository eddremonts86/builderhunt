---
title: Code fingerprinting v2, with style matching against your own codebase
slug: code-fingerprinting-v2
date: 2026-07-25
tags: [feature]
---

The first version of code fingerprinting was pure heuristics: per-language
vectors derived from a builder's public code, no model involved. It was honest
and it was shallow — it could tell you someone writes a lot of TypeScript, not
how they write it.

v2 adds an AI pass on top, as a separate rung rather than a replacement:

1. Shared sample-selection helpers pick representative files from a builder's
   public GitHub work instead of grabbing whatever came back first.
2. `POST /api/builders/:builderId/fingerprint` runs the `fingerprint-v2` task
   through the AI task registry, with a validated structured output.
3. The profile's style card renders the v2 result when it exists and falls back
   to the heuristic vector when it does not — no blank card, no fabricated one.
4. Style matching compares that fingerprint against a reference, so "writes code
   like ours" becomes a comparison rather than a vibe.

Every AI call goes through the shared registry, which means it is metered against
your organization's credit budget, cached, and covered by the kill switch. If the
provider is down or the budget is spent, you get the heuristic answer and a
reason — not a spinner.
