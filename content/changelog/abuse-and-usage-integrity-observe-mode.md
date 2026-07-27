---
title: Abuse and usage integrity, running in observe mode
slug: abuse-and-usage-integrity-observe-mode
date: 2026-07-24
tags: [feature]
---

Per-seat pricing only works if a seat is a person. A layer of detection now
exists for the cases where it is not, and — deliberately — it is watching rather
than enforcing.

What is live: device-keyed sign-up rate limiting, disposable-domain blocking with
plus-address normalization, linked-account clustering, and anomaly detectors for
impossible travel, sudden user-agent changes and seat overuse. Signals combine
into a single account risk score that decays over time, so one odd evening does
not follow you around for a month. Search rate limiting is keyed on identity
rather than IP, which stops a shared office network from throttling everyone in
it. Search, export and reveal actions meter into a daily per-seat counter.

`ABUSE_ENFORCEMENT_MODE` defaults to `observe`: signals are recorded and
inspectable in the admin console, and nothing is blocked. When enforcement does
turn on, the sequence is a warning in the app first, then a step-up re-auth
prompt, and restriction last. We would rather tell you something looks unusual
than surprise you with a locked account.

The fair-use policy this implements is written out in the pricing FAQ, and the
device recognition it relies on is disclosed in the privacy policy.
