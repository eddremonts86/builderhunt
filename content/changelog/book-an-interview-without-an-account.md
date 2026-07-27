---
title: Candidates can book an interview without creating an account
slug: book-an-interview-without-an-account
date: 2026-07-26
tags: [feature]
---

Asking a developer to sign up before they can pick a slot is a great way to lose
the developer. So they do not have to.

You send an interview invitation from a builder's profile. The candidate gets an
email with a link, opens a portal that shows your real availability, picks a
slot, and is booked. No account, no password, no BuilderHunt tenant. Booking,
cancelling and rescheduling all run inside one advisory-locked transaction, so
two people clicking the same slot cannot both win it.

The link carries a capability — a one-time secret that grants access to exactly
that invitation and nothing else. It lives in the URL *fragment*, so it is never
sent to our server logs or to any referrer, and only its hash is stored. That
last detail has a consequence worth stating plainly: **an invitation link cannot
be resent.** We do not have the secret any more, only its hash. If a candidate
loses the email, you issue a new invitation.

The portal runs under its own least-privilege database role that can reach the
invitation flow and nothing else in the schema.
