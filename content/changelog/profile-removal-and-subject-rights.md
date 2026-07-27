---
title: If you do not want to be in BuilderHunt, one request removes you everywhere
slug: profile-removal-and-subject-rights
date: 2026-07-27
tags: [feature]
---

BuilderHunt indexes public developer activity. Some of the developers it indexes
have not asked to be indexed, and they get a real way out.

- **Profile removal with global suppression.** A request at
  [/privacy/remove](/privacy/remove) removes the profile and records a
  suppression that applies across *every* organization — not just the one whose
  view prompted the complaint — and prevents re-ingestion on the next crawl.
- **Evidence provenance.** For any enrichment evidence attached to a profile, the
  subject can see which connector produced it, when, and from which URL.
- **Processing restrictions** cascade across organizations, so one restriction is
  not silently undone by another tenant's next enrichment run.
- **A [/crawler](/crawler) page** explaining exactly what our fetcher does, which
  user agent it sends, and how to block it, plus the sub-processors that were
  missing from the privacy policy — including the external AI provider, disclosed
  before it received production traffic rather than after.

The claim flow tightened in the same pass: verification is now bound to the
source account it came from, so proving control of a GitHub account proves that
and not identity in general, and platform admins can revoke a claim.
