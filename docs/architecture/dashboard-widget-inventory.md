# Dashboard widget inventory

Every widget `/dashboard` can render, and what each one costs and depends on. Plan:
[`plans/phase-2/04-dashboard-personalizado`](../../plans/phase-2/04-dashboard-personalizado/spec.md).

Written before the segment presets, because a preset is an ordering over this list and you cannot
order a list nobody has written down. The registry itself is
[`DashboardPage.tsx`](../../src/modules/dashboard/components/DashboardPage.tsx)'s `HOME_WIDGETS`; the
validation rules are in
[`widget-registry.ts`](../../src/modules/dashboard/lib/widget-registry.ts).

**This file is derived, not authoritative.** The registry is. `dashboard-widget-inventory.test.ts`
compares the two and fails when a widget is added, removed or renamed without this table moving —
otherwise it would be accurate for exactly as long as nobody touched the dashboard.

## How to read the columns

**Data** — where the widget's content comes from. Most read a *section* of the one
`GET /api/dashboard/overview` projection; the rest issue their own request. That distinction is the
whole cost story, so it is the first thing in the column.

**Gate** — what removes the widget from the page entirely, before any data is fetched: a role, or a
`WidgetDependency` (a capability that has shipped for this workspace, not a healthy endpoint).

**When empty** — what the frame does when the widget genuinely has nothing. `hide` removes it,
`third`/`half` shrink it, and a blank means it renders its own empty copy at full size. This is the
column a preset author gets wrong most easily: a route that promotes three `hide` widgets can render
a page with nothing on it.

## The widgets

| ID | Title | Span | Data | Gate | When empty |
|---|---|---|---|---|---|
| `first-hunt` | Run your first hunt | full | overview `summary` | — | n/a — it *is* the empty state |
| `action-queue` | Needs your attention | full | overview `actionQueue` | — | `hide` |
| `stat-builders` | Builders tracked | third | overview `summary` | — | own copy |
| `stat-active` | Seen active | third | overview `summary` | — | own copy |
| `stat-searches` | Saved searches count | third | overview `summary` | — | own copy |
| `upcoming` | Today and upcoming | full | overview `upcoming` | dep `calendar` | `hide` |
| `review` | Candidates to review | full | overview `review` | — | `hide` |
| `activity` | Builder recency | half | overview `recency` | — | own copy |
| `sprints` | Sourcing sprints | half | own fetch `GET /api/sprints` | — | own copy |
| `discovery-trend` | Newly tracked | half | overview `discoveryTrend` | — | `hide` |
| `alert-volume` | Alert volume | half | overview `alertVolume` | — | `hide` |
| `recommendations` | For you | twoThirds | own fetch `GET /api/recommendations` | — | own copy |
| `alerts` | Alerts | third | own fetch `GET /api/alerts/triggers` | — | own copy |
| `saved-searches` | Saved searches | twoThirds | own fetch `GET /api/queries` | — | `third` |
| `recent-builders` | Recent builders | third | own fetch `GET /api/builders/recent` | — | own copy |
| `plan-usage` | Workspace usage | half | overview `usage` | role `owner`, `admin` | `hide` |
| `team-activity` | Team activity | half | overview `activity` | dep `team-activity` | `hide` |
| `invitations` | Invitation status | half | overview `invitations` | dep `invitations` | `hide` |
| `profile-owner` | Your builder profile | third | overview `profileOwner` | — | `hide` |
| `shortlists` | Shortlists | half | overview `shortlists` | dep `shortlists` | `hide` |
| `source-mix` | Source coverage | half | overview `sourceCoverage` | dep `source-coverage` | own copy |

Twenty-one. `first-hunt` is the odd one: it is not a view of anything, it is the CTA that replaces the
page when the workspace tracks nobody, and its `isVisible` is the only one that reads a section in
order to decide whether to exist at all.

## Cost

**Sixteen of twenty-one widgets cost no request of their own.** They read sections of a single
`GET /api/dashboard/overview?range=…`, which is one round trip whatever the preset promotes. A
preset that reorders only these changes nothing about what the page fetches.

**Five issue their own request**, and they are the ones a preset can make expensive:
`sprints`, `recommendations`, `alerts`, `saved-searches`, `recent-builders`. They fetch on mount
regardless of position, so promoting one does not add a request — but *un-hiding* one does, and a
preset that shows all five where the general layout hid two adds two round trips to first paint for
that segment.

`recommendations` is the one to watch: it is the only widget whose cost is not a database read.

## Entitlement

No widget is gated on a plan tier in the registry, and that is deliberate rather than an omission.
Entitlement is enforced at each data source — `/api/alerts` answers 402 without
`paidActionsAllowed`, saved searches are capped by `PLAN_LIMITS`, sprints by
`SOURCING_SPRINT_LIMITS` — so a widget on a free workspace renders its honest empty or limited
state rather than vanishing.

The distinction matters for presets: **a preset must not become a second entitlement surface.**
Hiding `alerts` from a free workspace would tell somebody the feature does not exist rather than
that it is on another plan, and the two are different messages. `WidgetDependency` is for
capabilities that have not shipped at all; a plan limit is not one of those.

## What a preset may and may not change

A preset is presentation. It may reorder, resize, hide and add a CTA. It may not:

- **grant anything.** The server authorizes every data source independently; the presets resolve
  after role and dependency eligibility, never before;
- **hide a `critical` widget.** `action-queue` is the only one today. A payment failure or blocked
  work is not a preference, and `orderedWidgets` already ignores a hide on it — a preset must not
  become the loophole that a user preference is not;
- **reuse a retired id.** `RETIRED_WIDGET_IDS` exists because a saved hide for an old id would apply
  to unrelated new content, and `defineWidgetRegistry` throws on it;
- **outrank a saved layout.** Preferences persist per organization with a `revision`; a preset is
  the default a layout starts from, not something that overwrites one somebody arranged.

## Empty-state risk per candidate preset

Counted from the table above, because it is the failure a segmented dashboard reaches first — a
route whose widgets all `hide` when empty renders a blank page to a new account, which reads as
broken rather than as new.

| Route | Widgets that `hide` when empty | Always renders something |
|---|---|---|
| hiring | `review`, `shortlists`, `upcoming`, `discovery-trend` | `activity`, `saved-searches`, `recent-builders` |
| investing | `alert-volume`, `discovery-trend` | `saved-searches`, `alerts`, `activity` |
| building | `profile-owner` | `recent-builders`, `activity` |

`building` is the thin one: a builder who has not claimed a profile has `profile-owner` hidden and
is left with widgets about other people. Whatever that preset does, it needs at least one tile that
is about them and renders on an empty account — `first-hunt` covers a workspace tracking nobody, but
not a claimed-nothing builder.
