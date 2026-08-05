# Launch and distribution (spec)

> **Status**: `blocked` — every item happens at or after launch, and launch happens when phase-5 closes
> **Depends on**: [`01-production-readiness-audit`](../01-production-readiness-audit/spec.md) and
> [`02-legal-and-commercial-approvals`](../02-legal-and-commercial-approvals/spec.md)
> **Blocks**: nothing. This is the last phase of work, not a gate on any other.

## Why this plan exists

Created 2026-08-05, on the maintainer's instruction: move the launch out of phase-1.

Ten tasks across two phase-1 plans described the launch itself — a Show HN post, four blog posts to
publish, cross-posting, sitemap submission, launch-week monitoring, a monthly content review. They were
correctly written and impossible to finish, because a launch cannot be performed before a launch. While
they sat in the build phase, "phase-1 has 21 tasks left" was the honest count and the misleading one at
the same time: the build was finished; the launch had not started.

## What belongs here

An item belongs here when its value only exists once real people can see the product:

- publishing content, and distributing it on channels that read as spam without a live product;
- submitting the sitemap and asking search engines to crawl;
- watching what happens in the first days and weeks, then deciding from it.

An item does **not** belong here just because it is marketing. The four blog posts are already
*written* — the drafts are on disk, verified against the running app. Writing was engineering-adjacent
work and it is done. What is left is the decision to publish, which is the maintainer's, and it lands
here.

## Sequence

Strictly ordered, unlike the other two phase-5 plans:

1. Decide the indexing posture for `/blog`, `/changelog` and `/roadmap` — the task in plan 01. Today all
   three are `noindex`, so submitting a sitemap first asks Google to index a site whose blog is
   invisible.
2. Publish the four drafts, by renaming off the `_` prefix. `blog.ts` filters `_`-prefixed files and
   ignores a `draft:` frontmatter key entirely.
3. Submit the sitemap, once it contains what the decision in (1) says it should.
4. Show HN, then one channel per day. Not all at once: a thread nobody answers is worse than no thread.
5. Monitor daily for the launch week, weekly after, and write the 30-day review.

## Acceptance

- Every published post carries a `rel=canonical` to `builderhunt.dev` on every mirror, and UTM-tagged
  links so referrers are attributable.
- Search Console reports the sitemap as `Success` and the four sampled URLs preview with image, title
  and description.
- The 30-day review exists and states signups against the 200 target, the activation rate
  (`onboarding_progress.completed` / signups), the top three feedback themes, and the next-plan
  decision.
- No claim in any published post is unevidenced. Every quantitative statement maps to code or to a
  measured number — the standard `project-hygiene` was written to enforce, and the reason none of the
  four drafts claims a scale metric the corpus cannot support.
