# Rolling out user segmentation

The "Primary goal" question on `/me`, and the contract underneath it. Plan:
[`plans/phase-2/02-segmentacion-usuarios`](../../plans/phase-2/02-segmentacion-usuarios/spec.md).

## The one thing to keep straight

**A segment personalises. It never authorises.**

Nothing about `primary_segment` reaches `can()`, a route guard, `TenantPrincipal`, pricing or an
entitlement. Workspace permissions stay in `organization_role`, internal tools in `platform_role`,
commercial access in the plan. That is why a wrong segment is a bad recommendation and not a
security incident, and it is what makes shipping the taxonomy before the research that confirms it a
reversible decision rather than a bet.

The four values — `hiring`, `investing`, `building`, `other` — are an explicit hypothesis. The
interviews that would confirm them are in phase-5 because they need real users.

## Turning it on

```bash
USER_SEGMENTATION_ENABLED=true
```

Off by default. **Off means absent, not hidden:**

| With the flag `false` | |
|---|---|
| `/me` | the section does not render — the component hides itself on the API's 404 |
| `GET`/`PATCH` `/api/me/preferences` | `404`, before the session is even resolved |
| `/api/admin/metrics` | no `segments` block at all |
| `user_preferences` rows | untouched |

404 rather than 403 on the API is deliberate twice over: a 403 would confirm to an unauthenticated
prober that the route exists and is merely closed, and it would read as "you lack permission" —
the one thing this feature never says about anybody.

There is no client-side copy of the flag. The component learns the feature is off by being told
`404`, so there is exactly one place the decision lives and nothing to drift out of step with it.

## Rolling back

Set it back to `false` and redeploy. That is the whole procedure.

**Rows are not deleted.** Somebody who chose `hiring` still has `hiring` when the flag comes back
on, and does not get asked again. The flag governs the interface; it has never governed the data,
and a rollback that dropped preferences would punish the people who answered.

## Health check

With the flag on, and as a platform admin:

```bash
curl -s "$APP_URL/api/admin/metrics?fields=db" | jq .segments
```

```json
{ "hiring": 12, "investing": 3, "building": 41, "unknown": 508 }
```

Read it carefully:

- **`unknown` is a bucket, not a filter.** It counts accounts with no segment *and* accounts holding
  a value the current taxonomy no longer recognises. The numbers add up to the number of accounts
  with a preferences row; a distribution that silently failed to add up would be worse than one that
  admits it does not recognise something.
- **A missing `segments` key means the flag is off**, not that nobody has chosen. Absent and zero are
  different claims, and this endpoint does not conflate them — same convention as `removals`.
- Counts only. The spec permits internal staff to see aggregates and forbids using an individual's
  segment as support data, so there is no endpoint that returns who is in which segment.

## What the events say

Five, on the existing conversion stream, with the same rules: no identity, no free text, nothing
about a candidate.

| Event | Fires when |
|---|---|
| `segment_prompt_viewed` | the section is on screen — after the fetch resolves, never before |
| `segment_selected` | a first choice (`previous` was `null`) |
| `segment_changed` | a replacement, including clearing |
| `segment_skipped` | onboarding only; a person declined to answer |
| `activation_reached` | carries a coarse `activation_type`, never which search or which builder |

`segment_selected` and `segment_changed` are separate because they answer different questions — one
is whether the prompt works, the other whether the answer sticks — and one event could answer
neither.

The per-page-load dedupe key includes the chosen value, so somebody who tries three segments before
settling is recorded as three changes. Collapsing that to one would erase what the event exists to
measure.

## Changing the taxonomy later

Not by editing the enum in place. `segment_schema_version` records which taxonomy wrote each row, so
a revision is a migration that maps old values to new ones explicitly. A row written under version 1
keeps meaning what version 1 meant, forever.

`general` is not a segment and never will be stored. It is what every consumer renders for `null`,
resolved in one place — `resolveSegmentPreset` in
[`src/shared/lib/user-segments.ts`](../../src/shared/lib/user-segments.ts). Keeping it out of the
enum is what preserves the difference between "told us they are something else" and "never asked".

## Isolation

`user_preferences` is account-subject: rows are filtered on `app.user_id`, and the table has no
`organization_id` for a tenant filter to key on. A person keeps their goal when they switch
workspace, which is the point.

Row-level security is enabled **and forced**, and the application role holds `SELECT, INSERT,
UPDATE` — no `DELETE`. Removing preferences is not something the application does; the row dies with
the account through `ON DELETE CASCADE`.

Verified against the real `builderhunt_app` role rather than assumed, because unit tests connect as
a superuser and would have seen every row regardless:

```
as userA:  visible → userA only
           rows of userB visible → 0
           UPDATE ... WHERE user_id='userB' → UPDATE 0
           INSERT for userC → ERROR: new row violates row-level security policy
```
