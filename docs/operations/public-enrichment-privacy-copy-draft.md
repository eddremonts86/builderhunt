# Public-profile disclosure — draft copy for legal review

**Status: draft, not published.** This is the deliverable for the *"Update legal and product copy"*
task in [`plans/implemented/phase-1/42-stealth-scraping/task.md`](../../plans/implemented/phase-1/42-stealth-scraping/task.md),
which says explicitly: *"the wording needs a legal review signed off by a person; an agent may draft
it but must not record the approval."*

It lives here rather than in `src/routes/_landing/legal/privacy.tsx` for a mechanical reason: on this
repository a commit to `master` deploys, so writing this text into the live page **is** publishing
unreviewed legal copy. Review it here, then paste.

---

## The gap this fills

`/legal/privacy` §1 "Data we collect" lists seven categories: account, workspace, claim, usage,
device-recognition, interview, and cookies. Every one of them is about **a user** — someone who signed
up, or a candidate a user invited.

It says nothing about the public developer profiles the product indexes and scores. Those are personal
data belonging to people who have **no relationship with us at all**: they did not sign up, were not
invited, and in most cases do not know the product exists. That is the category a data-protection
authority looks at first, precisely because the data subject has no way to find out on their own.

The `/crawler` page already exists and is good — it names the user agent, what is collected, robots
handling, and how to opt out. What is missing is the same disclosure in the policy that carries legal
weight, in the vocabulary GDPR Article 13/14 uses.

**Two smaller things found while reading the page**, worth fixing in the same pass:

1. **Duplicate section numbers.** The headings run 1–12, then two further sections are numbered
   *"9. Interviews: documents, public links, audio, and AI"* and *"10. Interview credits (for
   companies)"* — colliding with the existing *"9. Children"* and *"10. Security"*. Anyone citing
   "section 9" of this policy is ambiguous today.
2. `ENRICHMENT_ENABLED` was `true` in production until 2026-08-05 while this very task was unchecked.
   It is now `false`, so the text below describes a capability that is **built and disabled**. If it
   ships before enrichment is re-enabled, keep the tense honest — say what happens *when* the feature
   is on, or hold the paragraph until it is.

---

## 1. Paste into `/legal/privacy` §1, as a new bullet

Insert as the **first** bullet in the "Data we collect" list — it is the only category whose subject is
not a user, so leading with it is more honest than appending it.

> **Public developer profiles (people who are not our users):** we index professional information that
> developers have published publicly on code hosts, forums and package registries — profile URL,
> username, display name, headline or bio, organization, location, language, topics, follower or
> reputation counts, and timestamps of public activity. We collect this from the platform's own public
> API or public pages, never from behind a login or a paywall, and we combine it into a profile so
> that people hiring can find developers by the work they have published. If this describes you, see
> [Public profiles](#public-profiles) below for the lawful basis, how long we keep it, and how to have
> it removed.

## 2. Paste into `/legal/privacy` as a new section

Place it immediately after "1. Data we collect", so the detail sits next to the category. Renumber the
sections that follow — and while renumbering, fix the duplicate 9 and 10 noted above.

> ### 2. Public profiles: lawful basis, retention and your rights
>
> **What we process.** The professional details listed in §1 under "Public developer profiles", plus a
> score we compute from them. We do not collect special-category data, we do not attempt to infer any,
> and we do not process public profiles for advertising or profiling beyond ranking search results.
>
> **Where it comes from.** Public APIs and public pages of the platforms named on our
> [crawler page](/crawler). Our crawler identifies itself as `BuilderHuntBot` and honours
> `robots.txt`; where a platform's terms forbid this we do not collect from it, even where those terms
> may not be legally enforceable.
>
> **Why we are allowed to (lawful basis).** Legitimate interests under Article 6(1)(f) GDPR: operating
> a search tool over professional information that its subjects chose to publish. We balanced that
> against your interests, and the balance is the reason for the limits above — public sources only,
> professional fields only, no special-category data, `robots.txt` respected, and unconditional
> removal on request. **You can object at any time under Article 21, and we will remove your profile;
> we do not require you to justify the objection.**
>
> **How long we keep it.** Accepted profile data is retained for at most 180 days from collection and
> is refreshed or dropped after that. Raw fetched material is kept for at most 30 days. If you ask for
> removal, we delete the profile and record a suppression entry so later collection does not bring it
> back — that entry holds the minimum needed to recognise the request, and nothing else.
>
> **Your rights.** Access, rectification, erasure, restriction of processing, objection, and
> portability, under Articles 15–22. You do not need an account to use them:
> [/privacy/remove](/privacy/remove) removes a GitHub, GitLab, Codeberg or DEV.to profile, or email
> **privacy@builderhunt.dev** and a person will answer. We will also tell you what we hold about you
> if you ask.
>
> **Complaints.** You can complain to your local supervisory authority. Ours is the Danish Data
> Protection Agency (Datatilsynet).

## 3. `/crawler` — one addition

The page is accurate as written. Add one line to the "How to make it stop" section so the two
opt-out routes are visible from either page:

> If you are not sure whether we hold a profile for you, ask at **privacy@builderhunt.dev** — we will
> tell you, and remove it if you want, whether or not you have an account here.

## 4. `README.md` — check, do not assume

The task says "correct any README or product claim that implies more than public-data collection". At
the time of drafting the README makes no enrichment claim at all, so there may be nothing to correct —
**re-read it at review time** rather than trusting this sentence, since it is the kind of statement
that goes stale.

## 5. Wording that must not appear

The plan is explicit, and it is worth repeating where the copy is written: never *"stealth"*, never
anything describing evasion, never a guarantee of access. The plan's own directory name
(`42-stealth-scraping`) is an internal artifact and must not leak into user-facing text. What the
product does is read public pages while identifying itself — say that.

---

## What review has to decide

1. **Is legitimate interests the right basis, and is the balancing test defensible as written?** This
   is the substantive legal question; everything else is drafting.
2. **Are the retention numbers the ones you want to commit to publicly?** 180 days for accepted data
   and 30 for raw are the current `ENRICHMENT_*_RETENTION_DAYS` defaults and `env.ts` caps them
   there — so the text and the code agree today. Publishing them makes them a promise, and changing
   them later means changing the policy too.
3. **Whether it publishes before enrichment is re-enabled** — see the tense note above.

**When it is signed off**, record the approval in
[`public-enrichment-source-register.md`](./public-enrichment-source-register.md) with the date and who
approved it, then check the task. An agent must not record that approval.

---

*Drafted 2026-08-05 against `src/routes/_landing/legal/privacy.tsx`,
`src/routes/_landing/crawler.tsx`, `src/shared/lib/env.ts` (the retention caps) and
`public-enrichment-source-register.md`. No claim here is made about behaviour I did not read in the
source.*
