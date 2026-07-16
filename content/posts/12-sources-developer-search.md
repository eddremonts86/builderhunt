---
title: The 12 sources I use to find developers in 30 seconds
description: A practical list of where to look when you need to find a developer for your project, with the strengths and weaknesses of each.
slug: 12-sources-developer-search
date: 2026-07-22
tags: [sourcing, list, how-to]
author: edd
---

# The 12 sources I use to find developers in 30 seconds

When you need to find a developer — for a hire, for a project, for an OSS contribution — you have 12 free, public sources to look at. Each one has a different shape of signal. Here's what each is good for, and when to use it.

## 1. GitHub

The obvious one. Strengths: real code, real activity, real open-source history. Weaknesses: most developers use it passively. The signal is in pushes, PRs, and issues — not in starred repos or follower counts.

**Use it for**: Engineers actively shipping. Look at their last 30 days of commits.

## 2. Stack Overflow

Surprisingly underused. Strengths: deep, specific technical knowledge. The top answerers for a tag are *experts* in that tag, not just dabblers. Weaknesses: less active than they used to be.

**Use it for**: Finding specialists. Filter by tag, look at top answerers for "all-time" — they're your shortlist for senior roles.

## 3. Hacker News

Strengths: signal density is huge. The comments are often better than the linked articles. Weaknesses: skews toward "thought leader" types who post a lot but ship less. Be careful not to confuse prolific commenting with shipping.

**Use it for**: Filtering for people who have opinions. Useful for content, marketing, and product roles.

## 4. DEV.to

Strengths: long-form technical writing. A developer who writes about React is more likely to be a senior React dev than one who only ships. Weaknesses: smaller than Medium, less mainstream.

**Use it for**: Discovering senior engineers who also teach. They tend to be high-signal candidates.

## 5. Reddit

r/programming, r/webdev, r/rust, r/ExperiencedDevs. Strengths: niche expertise, strong opinions. Weaknesses: signal-to-noise is the worst of the 12. Lots of lurking, lots of low-effort comments.

**Use it for**: Niche communities. If you're looking for a Vim user, try r/vim. A sysadmin, r/sysadmin.

## 6. Lobsters

Strengths: invite-only, high-quality. Similar to HN but with a stronger technical tilt and a smaller community. Weaknesses: small.

**Use it for**: Senior engineers. If someone's on Lobsters, they've passed a quality bar.

## 7. npm

The package registry. Strengths: track record of releasing real code. If someone maintains a package with 50k weekly downloads, they're a real maintainer. Weaknesses: doesn't show comments or activity outside of releases.

**Use it for**: Backend / infra people. They ship to npm. Look at maintainers of packages in your stack.

## 8. Hugging Face

The ML/AI hub. Strengths: model authors, dataset curators, paper authors with code. Weaknesses: only useful if you're hiring for ML.

**Use it for**: AI/ML roles. Period.

## 9. GitLab

The alternative forge. Strengths: many enterprise developers prefer it. Weaknesses: smaller than GitHub. Many people have accounts but post nothing.

**Use it for**: Enterprise-leaning developers. Especially EU-based.

## 10. Codeberg

The non-profit, Germany-hosted alternative. Strengths: privacy-conscious, FOSS-loving community. Weaknesses: small.

**Use it for**: FOSS purists. If you want to hire someone who's actually ideologically committed to open source, look here.

## 11. Hashnode

The dev blog network. Strengths: long-form technical writing, like DEV.to. Weaknesses: sometimes the platform has outages and the API can be flaky.

**Use it for**: Same as DEV.to — senior engineers who write.

## 12. SourceHut

The minimalist, email-driven forge. Strengths: hardcore Unix users. If someone's on SourceHut, they likely run their own infra. Weaknesses: small.

**Use it for**: Systems / infra / "old school Unix" people.

## How to actually use this

I built a tool that aggregates all 12: [BuilderHunt](/explore). Type a query, get a ranked list of the top 20 people actively working on that topic, drawn from all 12 sources. Save the search, get an alert when someone new appears.

But even without a tool, you can pick 2-3 of these sources for your specific need and run the search manually. The point is: don't just check GitHub. Check the others too.
