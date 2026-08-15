# Rolling out the personalized dashboard

`/dashboard` composed from the reader's segment. Plan:
[`plans/phase-2/04-dashboard-personalizado`](../../plans/phase-2/04-dashboard-personalizado/spec.md).
The widget list it orders is [`dashboard-widget-inventory.md`](../architecture/dashboard-widget-inventory.md).

## The one thing to keep straight

**A preset reorders. It never grants, never gates and never fetches.**

Role and dependency eligibility resolve first, so a preset that promotes a widget the reader's role
cannot see changes nothing — the role wins. Every widget keeps reading the source it already read,
so a preset changes the order of the page and not what the page asks for. And the server authorizes
each of those sources independently of all of this.

## Turning it on

```bash
DASHBOARD_PRESETS_ENABLED=true
```

Off by default, and **off means `general` for everybody** — the layout every account already has.
The switch is enforced in `/api/dashboard/context`, which answers `presetId: 'general'` whatever the
stored segment says, so there is one place the decision lives and the browser has no branch of its
own that could drift out of step with it.

A boolean rather than a percentage, unlike the onboarding ramp: nobody is ever mid-flow on a
dashboard. Turning this off is a page that reorders on the next load, not somebody stranded.

The segmentation flag matters too. With `USER_SEGMENTATION_ENABLED=false` nobody has a segment to
read, so every account composes as `general` regardless of this switch.

| | `DASHBOARD_PRESETS_ENABLED=false` | `=true` |
|---|---|---|
| widget order | registry order, or the reader's own | the route's lead order, or the reader's own |
| empty-state CTA | "Run your first hunt" → `/search` | the route's own heading, label and destination |
| `/api/dashboard/context` | answers, `presetId: "general"` | answers the stored segment's route |
| `segment` in that payload | still the person's real answer | unchanged |
| saved layouts | untouched | untouched |

`segment` keeps travelling with the flag off on purpose. It is the person's own answer, already
readable from their settings, and blanking it here would make the switch look like data loss.

## What a preset does to a layout somebody arranged

**It applies to what nobody has arranged, one dimension at a time.**

| Saved list | Empty | Non-empty |
|---|---|---|
| `orderedWidgetIds` | the route's lead order | the reader's order, whole |
| `hiddenWidgetIds` | the route's hides | the reader's hides, whole |
| `pinnedWidgetIds` | nothing — no route pins | the reader's pins |

Two consequences worth knowing before somebody reports either as a bug:

- **Changing your goal does not rearrange a dashboard you arranged.** Only the empty-state CTA
  follows, because that is presentation rather than layout.
- **Clearing a list is how the route's default comes back.** That is exactly what the Customize
  dialog's reset already writes, so "restore the preset" needed no new control, no second API and no
  second table.

A widget a route hides is still restorable: the moment somebody hides anything of their own, their
set is the truth and the route's hides no longer apply.

## Rolling back

Set it back to `false` and restart. Nothing is written per segment, so there is nothing to undo:
saved layouts are the same rows they were, and the page reorders on the next load.

`env` is frozen at module load. A changed `.env` means nothing until the process restarts, and
`/api/dashboard/context` reports what the **running process** has — read it there rather than from
the file.

## Health check

```bash
curl -s "$APP_URL/api/dashboard/context" -H "cookie: $SESSION" | jq
```

- `presetId: "general"` with a non-null `segment` means the switch is off in the running process;
- `capabilities` is what this deployment has shipped, not what the spec names — `pipeline` and
  `saved-search-health` do not exist, and a widget declaring them is omitted rather than rendered as
  a permanently blank tile;
- `entitlement` travels so the page can say "that is on another plan" instead of hiding a widget.
  Hiding would tell somebody the feature does not exist, which is a different message from the true
  one.

## Performance

**A preset adds no request.** Sixteen of the twenty-one widgets read sections of one
`GET /api/dashboard/overview`, and the five that fetch for themselves do so on mount regardless of
position. Promoting a widget is free; *un-hiding* one is not, which is why each route's `hidden`
list is short and deliberate.

`/api/dashboard/context` is one extra round trip on the dashboard, once per page load, cached for
five minutes.

### The reorder is visible, and that is the trade

The page paints in the general order and reorders when the context lands. For an account on
`general` — everybody, until this is switched on — there is no reorder at all. For a segmented
account there is one, and the alternative was holding first paint behind a preference lookup for
every reader.

`data-dashboard-state` includes the context query, so the E2E settle signal waits for the final
order rather than the first one. A spec that reads the widget sequence before it is `ready` reads
the general order — which is how this behaviour was found.

## Metrics

Not built. The spec asks for per-widget impression and interaction events, CTA use, and
activation/retention per preset, and what exists today is the action queue's own telemetry
(`queue-telemetry.ts`) plus the segmented onboarding funnel in `conversion_events`. Neither covers
widget impressions.

Stated here rather than left to be discovered from an empty chart: **do not ramp this on the promise
of measuring it.** Deciding whether a route is better than `general` needs the events first, and
they are a plan of their own.
