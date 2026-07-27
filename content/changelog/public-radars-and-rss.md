---
title: Share a saved search as a public radar, or read it in your RSS client
slug: public-radars-and-rss
date: 2026-07-25
tags: [feature]
---

A saved search can now be published as a **radar**: a public page for that query
that anyone can open without an account. Useful for "here is what we are looking
for" in a job post, a Discord, or a README — and useful to us, because these
pages are indexable.

Every saved search also has an RSS feed at `/api/feeds/:searchId.xml`, rate
limited, and the feed menu now has one-click deep links into Feedly and
Inoreader. If your working day already runs through a reader, BuilderHunt can
live there instead of asking for another tab.

The blog has a feed too, at `/blog/atom.xml`, and posts get generated OG images
so a shared link renders as a card rather than a bare URL.
