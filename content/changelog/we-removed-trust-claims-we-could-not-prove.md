---
title: We removed the trust claims we could not prove
slug: we-removed-trust-claims-we-could-not-prove
date: 2026-07-26
tags: [improvement]
---

An audit of our own landing page found numbers on it that nothing measured.
Social proof that was not counted from anything. A confidence figure that was
decoration. They are gone.

This is a deliberate, boring policy and it applies inside the product too. In the
same sweep we replaced the project-hygiene score — previously part heuristic,
part invented — with signals derived from real GitHub data and a deterministic
fallback that says "not enough data" instead of guessing a plausible-looking
number.

There is more of this to do. Several fields that arrive from source adapters are
synthesized rather than fetched, and we have them written down: Stack Overflow
supplies an accept-rate string as a bio, npm renders a 0–1 quality score in a
field the UI labels as followers, Hacker News echoes your own query keywords back
as the person's topics. Anywhere that still shows one of those as measured fact
is a bug we have not fixed yet, and we would rather tell you which fields to
distrust than let a clean-looking dashboard imply certainty it does not have.

If you spot a number in BuilderHunt you cannot trace to a source, that is worth
an email. It is a defect, not a feature.
