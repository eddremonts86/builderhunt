# Hero copy

## Persona variants — the four the product already knows

`hiring`, `investing`, `building` and `other` are not new categories invented for the home page: they
are `USER_SEGMENTS` in `src/shared/lib/user-segments.ts`, the same four the goal step writes and the
dashboard presets read. A fifth here would be a taxonomy nobody else honours.

**`hiring` is the current page, word for word.** That is the point of the column, not a coincidence —
the switch has to be invisible until somebody asks for it, so anyone arriving without `?persona=`
sees exactly what shipped. Every string in that column was copied out of
`src/modules/landing/components/HomePage.tsx`, not rewritten from memory.

| Block | `hiring` (default — current copy) | `investing` | `building` | `other` |
|---|---|---|---|---|
| **Hero sub-paragraph** | Activity scored for recency, so the top of your results are the people shipping right now. | Activity scored for recency, so you see what is being built while it is still being built. | Activity scored for recency, so the work you shipped this week is the work people find. | Activity scored for recency, so the top of your results are the people shipping right now. |
| **Persona-tabs headline** | Whoever you need to find, we surface them first. | Whatever you are watching for, we surface it first. | Whoever is looking for work like yours, we surface you first. | Whoever you need to find, we surface them first. |
| **CTA strip headline** | Start hunting the right builders. | Start watching the right builders. | Start with the profile we already built. | Start hunting the right builders. |

`other` deliberately repeats `hiring` rather than inventing a fourth voice. It is what the rest of the
product does with `other` — `resolveSegmentPreset` maps it to the general experience — and a variant
written for "somebody who declined to say" would be copy addressed to nobody.

## What the CTA strip's paragraph may not say, in any variant

The paragraph under the CTA headline is **not** persona-varied, and that is a constraint rather than
an omission. `HomePage.tsx` carries the reason in a comment beside it: `ACCESS_ALLOWLIST_ENABLED`
gates sign-up behind an `access_requests` approval queue, so any wording promising immediate access is
false whenever that flag is on — and it is on, in production and in `.env.example`.

`tests/unit/modules/landing/components/trust-claims.test.ts` matches the **raw source**, so these fail
the build wherever they appear, in a variant table as readily as in the component:

- `/no waiting list/i`, `/no waitlist/i`
- `/paid for itself/i`, `/beta user/i`, `/5 out of 5 stars/i`
- `/\d+M\+/`, `/\d+K\+ dev/i`, `/\+128 stars/`
- `/join alerts/i`, `/newsletter email input/i`

The shipped paragraph stays as it is for all four personas:

> Start on the Free plan, no credit card, no demo call. Set up your first hunt in under a minute, and
> upgrade only when you outgrow the limits.

## Default (`?persona=hiring` or no query)

```
Public beta · Free plan, no credit card

Find builders, not just repos.

Activity scored for recency, so the top of your results are the people
shipping right now.

[Start hunting]  [Browse builders]
```

The "Public beta · Free plan, no credit card" eyebrow stays; it mirrors
`src/routes/_landing/index.tsx`.

## Closing CTA, per persona

Separate from the table above because it is the block with the most ways to become false. The
paragraph beneath it does not vary at all — see the constraint section.

| Persona | Closing CTA headline | Grounded in |
|---|---|---|
| `hiring` (default) | Start hunting the right builders. | current `HomePage.tsx` |
| `investing` | Start watching the right builders. | same verb the investing segment page uses |
| `building` | Start with the profile we already built. | `builder_claims`, `/onboarding/building` |
| `other` | Start hunting the right builders. | repeats the default, as everywhere else |

### What an earlier draft of this file claimed, and why it is gone

The table these replace carried three claims that could not survive their own verification, and they
are recorded rather than quietly deleted because each is a different way to get this wrong:

- **"Search 12 sources in under a minute."** Wrong number — it is 13 — and, more importantly, a
  *literal*. `SEARCH_SOURCE_COUNT` exists because nine surfaces hardcoded 12 and all nine went stale
  the day two connectors were retired. Copy interpolates the constant or omits the count.
- **"Claim your builder profile in under 3 minutes."** No evidence anywhere for the duration. It is
  the kind of number that sounds measured and was not, and nothing in the product times a claim.
- **"Track 50 founders per workspace."** This one is *true* — `PLAN_LIMITS.free.savedBuilders` is 50
  — which makes it the instructive case: it still should not be typed here, for the same reason the
  source count should not. A number that is right today and written by hand is a number that goes
  stale silently.

## Persona switcher UI

Hidden by default. A `Different goal?` text link below the sub-paragraph opens a small
radio group with the four options. Picking one navigates to `?persona=X` and stays on the
home page. Default `hiring` is the `aria-pressed` choice.

```
Different goal?  ○ Hiring  ○ Investing  ○ Builder  ○ Something else
```

## Acceptance

- Default render matches the current `HomePage.tsx` exactly (no visible change for the
  no-query case).
- Persona variants swap only the three blocks listed above.
- Switching persona is keyboard accessible: Tab to "Different goal?", Enter to expand,
  arrow keys to pick, Enter to commit.
- The persona query param survives sign-in and account-claim flows (no stripping).
