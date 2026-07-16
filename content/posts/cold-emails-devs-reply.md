---
title: How to write cold emails that developers actually reply to
description: A practical guide to writing cold outreach to developers — based on sending 1,000+ emails and tracking what gets a response.
slug: cold-emails-devs-reply
date: 2026-07-29
tags: [outreach, hiring, how-to]
author: edd
---

# How to write cold emails that developers actually reply to

I sent 1,000+ cold emails in 2025. About 12% replied. Here's what I learned about the ones that worked.

## The biggest mistake

Most cold emails look like this:

> Hi [Name],
>
> I came across your profile and was impressed by your work on [Project]. We're a fast-growing [industry] startup looking for a senior [role] to join our team.
>
> [Generic pitch about the company]
>
> Would you be open to a quick chat?

This email fails for three reasons:
1. **It could be sent to anyone.** Replace [Name] with "Dear Sir/Madam" and it's the same email.
2. **It leads with the company, not the recipient.** The first sentence should be about *them*, not *you*.
3. **It asks for a generic "quick chat".** That's a meeting about nothing. Developers don't have time for that.

## What works instead

The emails that got replies had three things in common:

### 1. A specific, recent hook

Not "I came across your work" but "Your post last week on the tradeoffs of Rust's async runtime in production was exactly the kind of thinking we need on our team."

The hook has to be:
- **Specific**: name a post, a commit, a comment, a project
- **Recent**: last 30 days, ideally last 7
- **Demonstrably read**: don't fake it

The trick: finding the recent work is the hard part. A tool like [BuilderHunt](/explore) helps here — it surfaces what someone's been doing across 12 sources, so you don't have to manually check GitHub, DEV.to, Reddit, etc.

### 2. A specific question, not a generic ask

Don't ask "would you be open to a chat?" Ask "we're debating whether to use Tokio or async-std for our new service — your post suggested you'd go Tokio. Do you still hold that view after the recent changes in 1.40?"

The question:
- **Is answerable in 2-3 sentences**, so the developer can reply without committing to a call
- **Invites a real opinion**, not a yes/no
- **Is in their wheelhouse**, so they feel qualified to answer

You'll get a reply 30%+ of the time. The reply might be "I'm not interested" but it will be a reply, and you can iterate from there.

### 3. A clear, low-commitment next step

If the question reply is positive, the next step should be tiny. "Want me to send over the spec?" Not "When are you free for a 30-minute call?"

The bigger the ask, the more friction. Make the next step feel like a 2-minute reply, not a 30-minute meeting.

## Templates that worked

### Template 1: "I read your post"

> Subject: re: your [specific post title]
>
> Hi [name],
>
> Your [specific post] last [time period] made me realize you'd have strong opinions on [decision we're making]. We're a [brief context: 1 sentence] and we're trying to decide [specific decision].
>
> [Specific question about their post]
>
> No call needed — just curious what you'd do.
>
> [my name]

### Template 2: "Your open source work"

> Subject: [project] question
>
> Hi [name],
>
> I noticed you maintain [package/repo]. We're using it in production at [company] and it's been solid.
>
> One question: how would you feel about [small specific feature]? Would it be a fit for the project's roadmap, or would you prefer to keep scope tight?
>
> Not asking for code, just curious about your thinking.
>
> [my name]

## What doesn't work

- **"We're hiring"** in the subject line. They'll delete it.
- **Long pitches about your company.** The recipient doesn't care yet.
- **"Quick chat?"** as the ask. Make it specific.
- **Fake flattery.** "Your impressive background" reads as templated. Reference a specific thing instead.
- **Following up more than twice.** If they don't reply after two follow-ups over 2 weeks, give up.

## Tracking what works

I tracked every email in a spreadsheet:
- Date sent
- Recipient
- Source (where I found the hook)
- Subject line
- Reply? (Y/N)
- Outcome (call, no-call, referred out)

After 1,000 emails, the patterns are clear:
- Specific hook + specific question = 20-30% reply rate
- Generic "we're hiring" email = 3-5% reply rate

The difference is the upfront work. It takes 5-10 minutes per personalized email. That's why most people don't do it. The asymmetry is your advantage: most of your competitors are sending the generic version.
