---
title: The outreach generator drafts the email. You send it.
description: A walk-through of BuilderHunt's outreach generator v2 — how the v1 hook list and the v2 model differ, what the schema enforces, and why the product refuses to send on your behalf.
slug: outreach-generator-v2
date: 2026-08-04
tags: [outreach, ai, product, guide]
author: edd
---

There is a difference between a tool that helps you write an email and a tool
that sends one. The first one makes you faster. The second one makes you
accountable to a system that has no idea who you are.

The outreach generator in BuilderHunt does the first thing. It has done the
first thing since v1 shipped, and v2 — the model-backed version — still only
does the first thing. This post is about both, the upgrade between them, and
the line we will not cross regardless of how good the drafts get.

## What the generator actually produces

Three strings: a `subject`, a `body`, and a `hookSource` — the specific piece
of builder data the draft was anchored on. The hook source is the most
important field, because it is the one a reviewer reads first to decide
whether the draft is honest or a templated lie.

The generator never sends. It never schedules. It never opens a connection to
a third-party email service, never has access to your mailbox, never knows
your own address. The output is rendered into a draft box, and the only way
the email gets out is if you copy it and send it yourself. That is a design
decision, not a current limitation, and there is no plan to change it.

## How v1 worked, and why v2 exists

v1 was a rule-based composer with a hand-written list of "hooks" — pieces of
public builder data that could anchor a personalisation line:

```ts
const HOOKS: Array<{
  predicate: (b: OutreachContext['builder']) => string | null
  source: string
}> = [
  {
    predicate: (b) =>
      b.bio && b.bio.length > 10
        ? `your bio on ${b.source}: "${b.bio.slice(0, 80)}${b.bio.length > 80 ? '…' : ''}"`
        : null,
    source: 'bio',
  },
  {
    predicate: (b) => (b.topics?.[0] ? `your work on ${b.topics[0]}` : null),
    source: 'topic',
  },
  {
    predicate: (b) => (b.language ? `your ${b.language} work` : null),
    source: 'language',
  },
  {
    predicate: (b) =>
      b.followersCount && b.followersCount > 500
        ? `the ${b.followersCount.toLocaleString()} developers following your work`
        : null,
    source: 'followers',
  },
]
```

v1 picks the first hook whose predicate returns a non-null string and stitches
it into a hand-written template. The output is grammatically correct, often
boring, and always honest — because the template cannot mention something the
hook list did not provide. The `hookSource` label is the proof: if it says
`bio`, the personalisation line came from a verbatim quote of the bio.

v2 replaces the templating with a model call. The hook list still runs first,
because the model needs a specific piece of evidence to anchor on — handing
it the whole builder record is how you end up with plausible but invented
"your recent work on X" lines. The model receives the hook, the builder's
topics, the role you're hiring for, and the tone (`casual`, `professional`,
or `geek`). It produces the same three-field shape. The output schema
enforces a length budget on the body, a single sentence for the subject, and
a one-word `hookSource` enum so a reviewer can spot a hallucinated anchor
in two seconds.

## What the schema blocks

Three things the model is not allowed to do, by schema, not by prompt:

- **Invent hooks.** If the hook is the bio line, the `hookSource` has to be
  `bio`. The model cannot re-label it as "your recent work on X" without
  breaking the field. The hook is the truth, and the truth has a label.
- **Promise a meeting.** The body schema rejects strings that contain
  "let's hop on a call" or "schedule a chat" as the *opening* line. The
  closer can suggest a low-commitment next step ("want me to send the
  spec?"), but the model is not allowed to start there.
- **Claim to have read something it did not receive.** The body schema runs a
  validator that fails any draft containing phrases like "your recent post on
  Y" unless `Y` is present in the topics input. The model can quote a topic
  it was handed; it cannot pretend to have read a post it never saw.

These are not soft prompt instructions. They are runtime validators on the
output. The model can try to produce a draft that breaks them and the
generator will refuse to render the draft and surface a clear error to you,
because the right answer to "the model lied" is "the system caught it",
not "we'll improve the prompt".

## What the generator does not do

- **It does not find the email address.** The draft exists. The
  transport is yours. We chose this because the moment we look up an email
  for you, we are now a data broker for the address, and the consent story
  is no longer yours alone.
- **It does not track opens, clicks, or replies.** A "did they open it"
  signal requires sending the email, which requires the address, which
  we do not have. The drafts you keep are the drafts you saved; everything
  that happens after the email leaves your outbox is invisible to us, by
  choice.
- **It does not learn from your prior replies.** No training loop on your
  private sent folder. Every draft is generated from public builder data
  and the role you provided in that moment. Your reply history is not a
  feature input.

## The credit cost and the budget

Outreach is one of the metered features. Each draft spends one credit from
your organization's monthly grant. The cost is the same for v1 and v2: the
v1 path is free to render but the v2 path is the one that calls the model.
If your org is out of credits, you can still get v1 drafts — which is the
honest behavior, because refusing to help you write at all because a model
is busy is a worse product than a less-personalised draft.

Drafts are cached per `(organizationId, builderId, role, tone)` for an hour
in Redis, so two people on your team drafting the same builder for the
same role pay once. The cache key is on the inputs, not on the output, so
two recruiters can ask for "casual" and "geek" tones for the same builder
and both get what they asked for.

## When v1 is the right choice

If the role is a generic "senior backend engineer" pitch, the v1 draft is
probably the better one. v2's strength is the language: it can write a
geek-tone draft that name-drops a niche technical decision in a way the
template would not. For a generic role, the template is closer to
"professional-sounding and a bit boring", which is fine. The model is not
adding much when the role is vague.

For a niche role — say, "we're choosing between async-std and Tokio for a
new service" — v2 is the one that can produce a draft that mentions the
trade-off the candidate has actually thought about. The hook list still
runs first, so the personalisation comes from real data, but the language
is the model's. That is the case v2 is built for.

## What to do with the draft

Read it. Edit it. Send it from your own account.

The generator is a first-draft tool, not a finished-product tool, and the
honest version of that sentence is "the draft will not be good enough on
its own for anyone worth emailing". The candidates you actually want to
reach will read the email. The fastest way to lose them is to send a draft
the model wrote and you did not bother to read.

[Try it on a real builder](/search) — open a profile, hit "Draft
outreach", and read the hook source first. If you cannot verify it, do
not send the email. The point of the feature is to save you from the
blank page, not from reading your own messages.
