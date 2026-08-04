---
title: When the browser is the model — Chrome's built-in AI path
description: A walk-through of BuilderHunt's client-side AI path — what Chrome's Prompt API does, when it kicks in instead of the server model, the 4k-token context budget, and the privacy story.
slug: chrome-built-in-ai-path
date: 2026-08-12
tags: [ai, engineering, privacy, infrastructure]
author: edd
---

There is a tier of AI feature where the right answer is
"do not call our server, do not call anyone's server, do
not even leave the user's machine". The feature is
short-lived, the input is small, the output is
disposable, and the user is going to throw away the
result in a few seconds. The cost of a network round
trip is higher than the cost of the feature's value.
The privacy posture is "the data never leaves the
device", and that posture is a property a recruiter
might actually care about.

BuilderHunt has a small set of features that take this
path. They run on Chrome's built-in Prompt API, they
never hit a server, and they degrade gracefully when
the API is not available. This post is about what those
features are, what the path looks like in code, what
the context budget is, and the privacy story that is
worth a paragraph of its own.

## What Chrome's Prompt API is

A browser-native language model, exposed through the
`LanguageModel` global. It runs on the user's device,
in the user's browser, on hardware the user's browser
is using anyway. The model is downloaded by Chrome
once and updated in the background; the application
calls the global, gets a session, prompts it, and
destroys the session. The session is short-lived, the
model does not persist state between sessions, and the
prompt never leaves the device.

The model has limits. The context window is roughly
6k tokens; the model's quality is good for short
structured tasks and weak for long-form reasoning;
the API is not available in every Chrome version and
not available at all in other browsers. BuilderHunt
detects the API at runtime, uses it when it is
available, and falls back to a server-side model or a
non-AI path when it is not.

The model is also opt-in for the user. Chrome prompts
the user the first time a page tries to use it, and
the user can decline. A page that calls the API
without the user's consent is a page that gets a
silent "no" from the model, and the page has to handle
the silent "no" the same way it handles "the API is
not available".

## What features take the client-side path

A small set, and the rule for adding to the set is
deliberately narrow. The feature must:

- Be a single, short user-initiated action. The
  user clicks a button or types a phrase; the
  feature produces a result; the user reads the
  result and either keeps it or throws it away.
- Have a small input. The input is well under
  4k tokens, and the feature does not grow the
  input as the user does more.
- Produce a disposable output. The output is not
  persisted to the database, is not shared with
  other users, and is regenerated rather than
  re-displayed.
- Have a non-AI fallback that is good enough.
  The feature works without the model, the model
  is the upgrade, and the user is never blocked
  on the model.

The features that currently qualify are the
client-side versions of the "rewrite this in a
different tone" action on the outreach draft, the
"explain this commit in one sentence" helper on
the timeline, and the "summarise this post" helper
on the source-detail panel. Each is a single click,
a small input, a disposable output, and a non-AI
fallback that is a one-sentence description that
the user can ignore.

Features that do not qualify: anything that
persists, anything that is shared, anything that
needs to be reproducible across sessions. The
client-side model is a one-shot tool, and the
one-shot shape is the only shape that fits.

## How the call looks in code

The call is small, and the smallness is the
point. The wrapper module
(`src/shared/lib/ai/local.ts`) exposes a single
function that takes a system prompt, a user
prompt, and a Zod schema, and returns a
validated object. The session is created,
prompted once, validated, and destroyed:

```ts
import { z } from 'zod'

export interface PromptLocalOptions<O> {
  system: string
  prompt: string
  schema: z.ZodType<O>
}

export async function promptLocal<O>(
  options: PromptLocalOptions<O>
): Promise<O> {
  const ctor = (globalThis as { LanguageModel?: LanguageModelConstructor }).LanguageModel
  if (!ctor) throw new AIUnavailableError('chrome-prompt-api')
  const session = await ctor.create({
    initialPrompts: [{ role: 'system', content: options.system }],
  })
  try {
    const text = await session.prompt(options.prompt, {
      responseConstraint: zodToJsonSchema(options.schema),
    })
    const parsed = options.schema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new AIParseError(parsed.error)
    return parsed.data
  } finally {
    session.destroy()
  }
}
```

The `try/finally` around `session.destroy()` is
the part that prevents leaked sessions; an
exception during prompt or parse still destroys
the session. The `responseConstraint` parameter
is what tells Chrome to constrain the output to
the JSON Schema shape, which makes the parsed
result more likely to validate on the first try.
A failure to parse triggers a single retry with
a correction prompt, and the retry's failure
throws the parse error to the caller.

The `AIUnavailableError` and `AIParseError` are
the same error types the server-side AI path
uses, so the caller does not need to know which
path produced the result. The call site looks
the same whether the model is on the device or
on the server, and the caller is responsible
for handling both errors the same way.

## The context budget

The 4k-token budget is real, and the
`promptLocal` call site is the place the budget
gets enforced. The wrapper does not silently
truncate; it surfaces an error to the caller,
and the caller decides what to do. A caller
that can downsize the prompt does so; a caller
that cannot falls back to the server-side model
or to the non-AI path.

The budget is per-call, not per-session. A
session can hold the cumulative context, and
the next prompt in the same session can
exceed the per-call budget by using the
previous context. The wrapper does not use
multi-turn sessions, because the features
that take this path are one-shot, and a
one-turn session is the smallest surface for
the budget.

A future expansion to multi-turn sessions
would let the wrapper hold a short history
across clicks in the same page. The
expansion is not built, because the
one-shot features are the ones the path
is for, and a multi-turn session would be
the path's first use case for a feature
that does not exist yet.

## What the privacy story actually is

The model runs on the user's device. The
prompt never leaves the device. The output
never leaves the device, until the user
chooses to do something with it (copy it,
paste it into a draft, save it). The
feature is, in the strict sense, a
local-first feature, and the privacy
posture is the privacy posture of any
other client-side computation.

The privacy posture is also the reason
the client-side path exists for these
features. A recruiter who is writing
about a sensitive candidate (a current
employer, a competitor's employee, a
public figure) can use the "rewrite in
a different tone" action without
sending the draft text to a server.
The text is processed on the device,
the rewritten version is rendered on
the device, and the original text is
never logged or persisted by the
application.

The same posture is the reason the
client-side path is not used for the
features that need persistence. A
persona card, a code fingerprint, a
work-sample analysis — these are
shared, persisted, and compared
across users, and the right place
for them is the server. The
client-side path is the right place
for a feature that lives and dies
in one click.

## What happens when the API is not available

The path is a graceful degradation. The
caller catches the `AIUnavailableError`,
and the caller decides:

- If the feature has a non-AI fallback,
  the caller renders the fallback. The
  user sees a one-sentence description
  instead of a model-generated summary,
  and the feature still does the thing
  the user clicked on, just less
  impressively.
- If the feature does not have a
  non-AI fallback, the caller surfaces
  a "this feature is not available in
  your browser" message and disables
  the click target.
- If the caller wants the model output
  to be persisted, the caller falls
  back to the server-side model. This
  is the rare case; the path's
  features are mostly disposable.

The degradation is tested. The wrapper
module has a unit test that mocks the
global, returns `null` from the
`LanguageModel` lookup, and asserts
that `promptLocal` throws the
unavailable error. The caller tests
assert that the caller catches the
error and renders the fallback.
The two tests together are the
contract: the feature works
without the model, the model is
the upgrade, the upgrade is
optional.

## What this looks like in the app

The client-side features have a
small visual cue: a tiny "running
on your device" badge next to the
action button, with a tooltip
that explains what the badge
means. The badge is not a
marketing surface; it is the
user's signal that the prompt
is not leaving the device. A
user who cares about that signal
gets it; a user who does not
care does not see the badge as
friction.

The badge also disappears when
the API is not available, and
the action button stays. The
feature is the action, the
model is the upgrade, and the
upgrade is invisible when it
is not there.

## Why this matters for the product

The client-side path is a
privacy feature that happens
to also be a cost feature and
a latency feature. The model
runs on the user's device, the
user pays for the electricity,
the user gets the result in
milliseconds, and the data
never leaves the device. The
three properties reinforce
each other, and the
reinforcement is the reason
the path exists.

A feature that is privacy-positive
and cost-positive and latency-positive
is a feature that should be on the
client. A feature that is
privacy-positive but cost-negative
or latency-negative is a feature
that has to be on the server,
because the cost and the latency
are the price of the privacy.
BuilderHunt's features that take
this path are the features where
all three line up, and the list is
small because the alignment is
uncommon.

The list grows when a new feature
fits the rule. The rule is the
rule. The features are the features
that fit it. The path is the
smallest part of the AI platform,
and the smallest part is the one
that needs the least explanation.

[Try the chrome-ai path on a
tracked candidate's profile](/search) —
open the timeline, click "explain
this commit in one sentence", and
look at the badge. The badge is
the proof. The proof is the
sentence. The sentence is on your
device.
