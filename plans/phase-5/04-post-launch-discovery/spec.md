# Post-launch discovery (spec)

> **Status**: `blocked` — every item needs real users to talk to
> **Depends on**: [`03-launch-and-distribution`](../03-launch-and-distribution/spec.md)
> **Blocks**: nothing. It *used* to block five of phase-2's seven plans, which is why it is here.

## Why this plan exists

Created 2026-08-05, on the maintainer's instruction: move anything that stops the app being built.

`plans/phase-2/01-investigacion-icp` asked for fifteen interviews with real hiring, investing and
building professionals, then an ICP decision approved by product and marketing. Its `Blocks:` header
named `02-segmentacion-usuarios` and `06-landing-segmentada`, and `02` in turn blocks `03` and `04`. So
**five of phase-2's seven plans waited on conversations with strangers who cannot be recruited before
there is a product to show them.**

That is the wrong dependency direction for a pre-launch product. The taxonomy those interviews were
meant to validate is *already written down* — `hiring | investing | building | other`, with its
rationale, in [`plans/phase-2/README.md`](../../phase-2/README.md). Segmentation can be built against
that hypothesis, shipped behind a flag, and corrected by what real users say. Building it after the
research would have meant building nothing for months.

## What belongs here

An item belongs here when its input is **what a real user says or does**, and no amount of engineering
substitutes for it:

- interviews and their synthesis;
- a decision whose acceptance criterion is an explicit product-and-marketing approval of a positioning
  claim;
- a cohort rollout whose evidence is behaviour across weeks.

An item does **not** belong here because it is "research-flavoured". Writing the interview guide,
recording the measurable baseline, and choosing a default taxonomy are all work an engineer or a founder
can do today, and they stay in phase-2.

## The inversion this plan records

Phase 2 was written as *research → decide → build*. It now runs as **build the hypothesis → launch →
learn → correct**, which is the only order available to a product with no users. The taxonomy in
`phase-2/README.md` becomes the falsifiable hypothesis instead of the conclusion, and the interviews
become the test of a live product rather than a prerequisite for having one.

The risk that creates is real and worth naming: shipping segmentation nobody validated means the segment
names may be wrong. It is mitigated cheaply — `user_segment` personalises messages and priorities and
**never grants permissions** (phase 2's own first non-negotiable principle), so a wrong segment costs a
mistargeted headline, not a security boundary. That is why the inversion is safe here and would not be
safe for, say, authorization.

## Acceptance

- Fifteen scorecards exist, anonymised, with conclusions linked to evidence rather than to impressions.
- The ICP decision names the primary segment, the buyer, the user, the payer, the JTBD, the activation
  moment, the message, the CTA and the open questions — and is explicitly approved.
- Whatever the research contradicts in the shipped taxonomy is filed as a change to phase-2's plans, not
  silently absorbed. A hypothesis that cannot be wrong was never a hypothesis.
