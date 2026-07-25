---
title: Working title in sentence case
description: One sentence, 140-160 characters, written for a search result — say what the reader gets, not what the post is about.
slug: url-slug-matching-this-filename
date: 2026-01-01
tags: [topic, format]
author: edd
---

<!--
  Authoring scaffold. The leading underscore in the filename keeps this out of
  `getAllPosts` (see the filter in `src/shared/lib/blog.ts`), so it never
  appears on /blog, /blog/$slug or the Atom feed. Copy it to a real filename
  and delete these comments.

  House style, learned from posts 1-3:
  - First person, specific, no throat-clearing. Open with the reader's problem
    in one or two sentences, not with "In today's fast-paced world".
  - Every claim about BuilderHunt must be true of the app as it exists today.
    If a feature is planned, say it is planned. This is the rule that matters
    most — a marketing post that oversells is a bug report waiting to happen.
  - Numbers need a source. Don't invent scale metrics ("we indexed 4M
    profiles") to sound bigger.
  - Link internally where it actually helps the reader: /explore?q=… for a
    live example, /pricing only in the closing CTA.
  - Code snippets must compile against the real signatures in the files you
    cite. Sanitize secrets, keep the shape honest.

  Frontmatter rules:
  - `slug` must equal the filename without `.md`, or /blog links 404.
  - `date` is `YYYY-MM-DD`; /blog sorts newest first.
  - `tags` are lowercase; reuse existing ones where they fit so related-post
    matching (`getRelatedPosts` scores tag overlap) has something to work with.
-->

Open with the problem in the reader's words. Two or three sentences, concrete,
no preamble. The reader should recognise themselves by the end of it.

## The first section makes one point

Body. Keep paragraphs short. Prefer a real example over an abstraction.

## The second section makes the next point

Body.

## The third section is where BuilderHunt shows up

Introduce the product as the answer to what the post has already established —
not before. Show it doing the specific thing the post is about, with a link to
a live example such as [an explore query](/explore?q=rust).

## What to do next

Close with one action, one link. Do not stack CTAs.

[Try it free](/auth/sign-up) — no credit card, and the free tier is enough to
work through everything above.
