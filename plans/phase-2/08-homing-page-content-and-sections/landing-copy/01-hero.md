# Hero copy

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

## Persona variants

The persona switch swaps three text blocks per persona. The headline, the bento features
that follow, and the rest of the page stay identical.

| Persona | Sub-paragraph | Persona-tab headline | Closing CTA |
|---|---|---|---|
| `hiring` (default) | Activity scored for recency, so the top of your results are the people shipping right now. | Whoever you need to find, we surface them first. | Create a free workspace. Search 12 sources in under a minute. |
| `investing` | Track who is shipping what. Across code, conversation, and publishing. | Map a market without scraping it. | Sign up free. Track 50 founders per workspace. Upgrade for unlimited. |
| `building` | Claim your profile. Show the work. Skip the spam. | Your public work, indexed by people who care. | Claim your builder profile in under 3 minutes. |
| `other` | We don't know your job yet. Tell us. We will show you where BuilderHunt fits. | If you read code, you can use this. | Browse public builders without signing up. |

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
