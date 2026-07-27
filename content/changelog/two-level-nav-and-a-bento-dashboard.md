---
title: A two-level dashboard shell, and a dashboard that actually shows something
slug: two-level-nav-and-a-bento-dashboard
date: 2026-07-27
tags: [feature, improvement]
---

The dashboard used to hide most of itself. Twenty-three destinations existed;
sixteen of them lived behind an avatar dropdown, including every admin page and
all five workspace settings pages. If you had never clicked the avatar, half the
product did not exist for you.

Navigation is now two levels: a narrow rail of **areas** (Home, Discover,
Pipeline, Signals, Workspace, and Admin for platform admins) and a panel that
lists the destinations inside the open area. Both levels and the topbar
breadcrumb are generated from one array, so a new page appears in all three
places at once instead of being wired up three times — or, as happened
repeatedly, wired up once and forgotten.

The overview page changed with it. `/dashboard` is a bento grid now, and four
features that had shipped without any presence there finally have one: sourcing
sprints, the alerts inbox, exports, and your tracked-builder counts. Tiles size
themselves to their content instead of clipping it.

Nothing moved out of reach: every destination that was in the dropdown is still
reachable, just in an area that names it.
