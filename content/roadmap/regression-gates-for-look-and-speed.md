---
title: Visual and performance regression gates
slug: regression-gates-for-look-and-speed
status: in_progress
category: infrastructure
ship_estimate: Q3 2026
order: 40
---

A checked-in performance budget already fails the build when an image or a bundle gets heavier. The remaining work extends that to the rendered result: Lighthouse in CI on the public surfaces, and visual snapshots so a token change cannot quietly restyle a page nobody reopened. Boring, and the reason a redesign does not silently regress the pages you use most.
