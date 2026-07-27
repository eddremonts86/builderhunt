---
title: The landing page got lighter, and now has a budget it cannot exceed
slug: faster-landing-and-a-performance-budget
date: 2026-07-26
tags: [improvement]
---

The hero screenshots were PNGs, served at one size to every device. They are now
AVIF and WebP at three desktop widths and two mobile widths, art-directed so a
phone gets a crop that is legible rather than a shrunken desktop layout.

The part that keeps it that way: a checked-in performance budget. A script
asserts a maximum byte size per variant, the expected pixel width, the expected
aspect ratio, and a total transfer budget for the two viewport cases that matter
— 150 KiB at 390px, 300 KiB at 1440px. It runs in CI. Adding a heavier image
fails the build instead of quietly costing every visitor half a second.

Image generation is deterministic — the same source bytes produce the same output
bytes — so re-running it never produces a spurious diff.
