---
title: Interview booking without an account — how the candidate never has to sign up
description: A walk-through of the candidate-side booking flow — what the link in the email does, why it lives in the URL fragment, how the slot-pick is atomic, and the design decisions that make the whole thing passwordless.
slug: interview-booking-without-account
date: 2026-08-12
tags: [product, security, hiring, guide]
author: edd
---

The candidate you want to interview does not want to
create an account. They are busy, they have a job, they
do not have time to set a password, verify an email, and
learn a new tool just to pick a time on your calendar.
If the booking flow asks for any of those things, the
candidate books the slot you do not want them to book
— the one a week out, the one that signals "I am not
that interested".

BuilderHunt's interview booking flow is built to avoid
this. The candidate opens a link from an email, sees
your real availability, picks a slot, and is booked. No
account. No password. No "create a profile to continue".
This post is about how that flow works, the security
model that makes the passwordless part safe, and the
specific design decisions that keep the candidate from
ever touching a sign-up form.

## The flow, end to end

You open a tracked candidate's profile. You click
"Invite to interview". The system:

1. Reads your real availability from the calendar
   you maintain inside BuilderHunt — the same
   calendar that also surfaces interview slots,
   worker runs, and alert deliveries.
2. Generates a one-time capability token bound to
   this candidate, this interview round, and this
   calendar's current state.
3. Sends the candidate an email with a link to
   `/interview/$interviewId#capability=$token`. The
   token lives in the URL fragment, not the URL
   path.
4. The email is plain text, with a one-sentence
   summary of who is inviting them and what the
   role is. No tracking pixel, no read receipt.

The candidate opens the link. Their browser navigates
to the page; the server only sees
`/interview/$interviewId` in the request line, never
the fragment. The page is a small client-side script
that extracts the capability token from the fragment,
sends it as a header to the booking endpoint, and
renders the available slots.

The candidate picks a slot. The booking endpoint
verifies the token, marks the slot as taken, and sends
both parties a confirmation email. The candidate's
involvement with BuilderHunt ends there. They never
created an account, never set a password, never gave
us anything except the slot they picked.

If the candidate cancels or reschedules, the same
flow runs in reverse: they open the same link, see
the booking, pick a new slot or hit "cancel". The
token is the same one; the endpoint accepts both
actions as long as the token is valid.

## Why the token lives in the URL fragment

The fragment (`#capability=...`) is the part of the URL
that is sent to the client and never to the server. The
browser strips it before issuing the HTTP request. The
server never sees the token in any log line, in any
access record, in any Sentry breadcrumb, in any proxy
header, in any backup.

This is the property that lets the link be sent over
email. The candidate's email client may route the
email through a service that pre-fetches links to scan
for malware; the pre-fetch hits the booking page, not
the token, and the pre-fetch cannot pick a slot. The
token only becomes visible when the candidate actively
opens the link in a browser that executes JavaScript,
and the page explicitly extracts the token from the
fragment on the client side.

A token that lives in the URL path is a token that
ends up in the server's access log, in the proxy's
forwarded headers, in the error tracker's URL
record, in every backup. A token that lives in the
URL fragment is none of those things. The cost of
the fragment is one extra line of client-side code;
the benefit is "the token never reaches the server
in cleartext, ever".

The token is also one-time. Once the candidate picks
a slot, the token is invalidated, even if it has not
expired. Once the interview round ends (either by
booking, by cancellation, or by the round's TTL), the
token is invalidated, even if it has not been used.
There is no "valid until explicitly revoked" path,
because a long-lived token is a token that will
eventually leak.

## Why the slot-pick is atomic

Two candidates clicking the same slot cannot both
get it. The booking endpoint runs the slot-update
and the booking-record-insert in a single database
transaction, and the slot-update is a conditional
update that fails if the slot has already been
taken:

```sql
UPDATE interview_slots
SET state = 'booked', booked_by = $candidateId
WHERE id = $slotId
  AND state = 'available'
  AND interview_round_id = $roundId
RETURNING id;
```

If the `UPDATE` returns zero rows, the slot was
already taken. The transaction rolls back, the
endpoint returns a 409 with a "slot was just
taken" message, and the page re-renders the
remaining available slots. The candidate picks
another slot or walks away. The first candidate
to complete the booking wins, and the second
candidate gets a clear, fast, non-blaming
explanation.

The atomicity is enforced at the database, not in
application code. Application-level locking is
what produces the kind of "the slot is held for
you for the next 30 seconds" UX that pretends
the slot is taken without actually taking it. The
database-level update is the one that cannot be
cheated.

## What the candidate sees

A clean page with three things: the recruiter's
name, the role title, and a list of available
slots. No BuilderHunt branding on the page header.
No "create an account" CTA. No upsell. The page
exists to pick a time, and the page is shaped
around that one action.

The slot list is filtered to the next N days by
default, with a "show more" link if the candidate
wants to look further out. Each slot shows the
local time zone the candidate's browser is set
to, not the recruiter's time zone, so the
candidate does not have to do the conversion in
their head. The time zone is detected from the
browser, not stored on our side.

A confirmation screen after the booking shows
the chosen time in the same local time zone, the
interview format (video link, phone number, or
in-person address — set by the recruiter when
they created the round), and a "reschedule or
cancel" link that points back to the same
fragment-URL pattern.

## What the recruiter sees

A real-time view of the round in the dashboard:
slots taken, slots still available, slots that
expired without being picked, and a one-click
"resend the invitation" action for the cases
where the candidate lost the email. The
resend generates a new token, invalidates the
old one, and sends a fresh link.

The recruiter's calendar is also the source of
truth for availability. If the recruiter has a
meeting they forgot to mark as busy, and a
candidate books a slot inside that meeting, the
recruiter sees the conflict on the calendar
view, not on the booking confirmation. The
booking does not check the recruiter's external
calendar; that is a future feature, and the
honest answer to "will BuilderHunt block this
slot because Google Calendar says I'm busy" is
"no, not yet, this is on the roadmap".

## What the security model is and is not

The capability token is the security boundary.
The token:

- Is bound to a specific interview round, so a
  token for round A cannot be used against
  round B.
- Is bound to a specific candidate, so a token
  cannot be forwarded to a different candidate
  to book on their behalf.
- Has a TTL of 14 days by default, so a
  forwarded email becomes useless after two
  weeks.
- Is one-time, so a successful booking
  invalidates the token.
- Is hashed, not stored in cleartext, so the
  database compromise does not produce
  reusable tokens.
- Is delivered in the URL fragment, so it never
  reaches the server logs.
- Is rate-limited by IP, so a brute-force
  attempt to guess the token is rejected by
  the rate limiter before it can hit the
  booking endpoint.

The model is not:

- A proof of identity for the candidate. The
  candidate is identified by the email address
  the invitation was sent to, and the
  capability token proves the candidate
  controls the inbox, not that the candidate
  is the person whose name is on the
  application.
- A proof that the email is still the
  candidate's primary contact. The candidate
  could have changed jobs; the invitation
  still goes to the address the recruiter
  used. The recruiter is responsible for the
  freshness of the contact.
- A replacement for the recruiter's own
  interview process. The booking flow gets
  the candidate on the calendar; the
  interview itself is the recruiter's
  responsibility.

The model is designed to fail safe. A leaked
token grants the ability to book, cancel, or
reschedule one interview, and the leak window
is the 14-day TTL or the round's end. The
failure mode is "an impersonator books an
interview slot that the real candidate
wanted to book anyway", which is not a
catastrophic failure and which the
recruiter can detect and remediate.

## What the candidate experience is not

It is not a marketing surface. The page does
not show the recruiter's logo, the company's
values, or the team's recent shipping. The
page is a booking page, and the booking is
the action.

It is not a tracker. There is no analytics
script on the page that follows the candidate
around the web. The only "tracking" is the
booking itself, and the booking is the point
of the flow.

It is not a one-way door. The candidate can
reschedule, cancel, or simply not respond.
The token is invalidated in all three cases,
the slot is released, and the recruiter sees
the result on the round's dashboard.

## What this looks like in the app

The candidate receives a single email with a
single link. The link opens a page with the
recruiter's name, the role, and the available
slots. The candidate picks a slot, sees a
confirmation, and the flow is over. The
recruiter sees the booking on the round
dashboard and on their calendar.

The shape is the shape it is because the
candidate is the one who has the worst
experience if the flow is bad, and the
recruiter is the one who pays the cost of a
missed booking. A booking flow that protects
the recruiter from the candidate's friction
is a booking flow that produces no-shows. A
booking flow that protects the candidate from
the recruiter's friction is a booking flow
that fills calendars.

The product is built around the second
shape. The recruiter is the one who has the
work to do; the candidate is the one the
work is for; the flow is shaped around the
candidate's experience because the
candidate's experience is the variable the
recruiter is trying to optimise.

[Try a search](/search), track a candidate,
hit "Invite to interview", and walk through
the flow as the candidate. The five-second
version of "how good is this" is "would I
book an interview through this link if I
were the candidate". The answer is the test
the feature is meant to pass.
