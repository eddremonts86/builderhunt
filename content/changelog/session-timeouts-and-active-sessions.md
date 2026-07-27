---
title: Session timeouts, and a panel that shows every device you are signed in on
slug: session-timeouts-and-active-sessions
date: 2026-07-24
tags: [feature]
---

`/settings/security` now lists your active sessions — device, approximate
location, last seen — and lets you revoke any of them. If a session there is not
yours, revoke it and change your password.

Behind it, sessions gained an idle timeout and an absolute timeout, both
configurable per deployment, plus a concurrency limit per plan. Under abuse
enforce mode the limit is one-in-one-out: signing in on a new device ends the
oldest session instead of refusing the new one, which is the behaviour that fails
in the direction of the real user rather than the attacker.

A laptop and a phone at once is normal and stays fine. The limits exist for
credential sharing, not for people who own two devices.
