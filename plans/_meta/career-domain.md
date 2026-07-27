# Career-domain contract

Binding for the three candidate-side plans in fase 2:
[`job-opportunities-workspace`](../phase-2/job-opportunities-workspace/spec.md) →
[`ai-cv-generation-and-tailoring`](../phase-2/ai-cv-generation-and-tailoring/spec.md) →
[`delegated-job-applications`](../phase-2/delegated-job-applications/spec.md).

Written 2026-07-27. This existed only as prose repeated inside three specs, which is how contracts
drift. It lives here so there is one copy to change.

## Why this domain is different

Every other tenant-private table in BuilderHunt is owned by the *organization*: any member with the
right role may read it. A job search is not. The subject is the individual, the organization is
incidental, and an organization admin reading a colleague's job applications is a privacy incident,
not a feature.

That single difference drives every rule below.

## 1. Ownership and RLS

Every career/job/application table carries **both** `organization_id` (NOT NULL, FK) and
`owner_user_id` (NOT NULL, FK).

The RLS predicate is **tenant AND owner**. The tenant predicate alone leaks between members of the
same organization. The shape to mirror is `drizzle/0085_candidate_documents_rls_grants.sql`, which
walks back to an `owner_user_id` for exactly this reason — though note that table reaches it
through a three-join `EXISTS`, whereas a career table compares `app.user_id` directly.

Every plan carries a **negative test** proving an organization admin gets `404`/empty — never
`403`. A 403 confirms the row exists, which is itself the leak.

## 2. Principal resolution

Tenant context is resolved server-side by `requireCareerPrincipal`
(`src/shared/lib/auth/career-principal.ts`, created by `job-opportunities-workspace`), which always
resolves the subject's **personal** organization. Never the active company context, never a
client-supplied organization id. The other two plans consume it; they do not write a second one.

Authorization actions resolve as `resource.creatorUserId === principal.userId` — the same predicate
across all three plans, not three variations.

**On the owner field.** All three plans reuse `ResourceAuthorizationContext.creatorUserId` as the
owner slot rather than adding an `ownerUserId` field. That is a deliberate choice to avoid three
plans racing to add the same field to `permissions.ts`, and it matches the shipped `calendar:*`
block, which already overloads it the same way. The overload is real and worth cleaning up — one
coordinated rename across `permissions.ts` and its callers — but that is a separate refactor, and
until it happens **no career plan adds `ownerUserId` to that context type**. The database column is
still named `owner_user_id`; only the in-memory authorization context reuses `creatorUserId`.

## 3. Worker access

`withWorkerOrganization` sets only `app.organization_id`. Under an owner-scoped predicate that makes
`owner_user_id = NULL`, so every policy evaluates false and the worker **reads zero rows without
raising an error** — the silent-failure class this repo has been bitten by before. Career workers use
`withCareerWorkerSubject(organizationId, ownerUserId, …)` instead, and their acceptance criteria
assert `>= 1` row as the real `builderhunt_worker` role, not as the owner.

## 4. Separation from the employer side

Candidate-side tables **never** write to `pipeline_*`, `candidate_submissions`,
`organization_builders` or ATS integration tables. The employer-side hiring pipeline looks
superficially like an application tracker and is not one: different subject, different consent,
different disclosure obligations, different retention.

`job_applications` never writes to `pipeline_*`.

## 5. AI task ids — one owner each

| Task id | Owner |
| ------- | ----- |
| `job-description-extract` | `job-opportunities-workspace` |
| `career-facts-extract`, `resume-base-compose`, `resume-job-fit-analyze`, `resume-tailor`, `resume-quality-review` | `ai-cv-generation-and-tailoring` |
| `candidate-job-fit`, `application-cover-letter` | `delegated-job-applications` |

`resume-job-fit-analyze` and `candidate-job-fit` are deliberately distinct with separate caches —
one scores a CV against a posting for tailoring, the other scores a person against an opportunity
for triage. Fusing them conflates two different questions.

All five CV tasks are **server-only**. Chrome built-in AI is not in their degradation ladder: a CV
plus a job posting does not fit its context window, and three of the five run in the background
where no browser exists. Do not plan a local-first path for them.

## 6. Caching

`tenantAiCacheKey` is mandatory. `getCached`/`setCached` are **banned** in this domain: their key is
`ai:cache:{taskId}:{hash(input)}` with no organization component, so two people with similar CVs
would share a cache entry. This is a latent cross-tenant leak in the generic helper, not a
theoretical one.

## 7. Truthfulness

A generated CV or cover letter that asserts something the person never did is the failure mode that
kills the product. Every generated claim links to a stored career fact. An output containing a claim
with no backing fact is **rejected whole** — one retry, then deterministic fallback. Never
partial-keep: salvaging the "good" claims from an output that demonstrably hallucinated is precisely
the error to avoid. The user may either remove such a claim or convert it into a fact they assert
themselves.

Workers may propose facts but never confirm them: `builderhunt_worker` holds SELECT+INSERT on
`career_facts` with `WITH CHECK (… AND status = 'proposed')`, and no UPDATE or DELETE. "AI never
auto-confirms" is a grant, not an intention.

## 8. The ethical floor on delegated applications

The MVP **prepares and assists**. It never submits an external form, never creates an account on a
third party's site on the user's behalf, never impersonates the user, and never sends an application
without per-application explicit human approval. "Delegated" means the product does the research and
the drafting; the human does the sending.

The approval gate is un-bypassable by design rather than by UI convention: approval is recorded
per-application, cannot be pre-granted in bulk, and an idempotent retry never turns one approval into
two actions.

## 9. Shared code surfaces

All three plans touch `src/shared/lib/ai/tasks.ts`, `src/shared/lib/billing-shared.ts`,
`src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/authorization/permissions.ts`,
`src/shared/lib/db/schema.ts`, `src/shared/lib/operational-schedules.ts` (unique `jobKey`s) and the
`career` area in `src/modules/dashboard/ui/shell/nav-config.ts` — whichever plan lands first creates
that area; the others add to its `items` **and** its `routes` prefix list.

Expect merge conflicts. Keep every identifier unique.

## 10. Data model contract published downstream

`job_opportunity_versions` is **immutable and append-only**, enforced by the absence of any
`GRANT UPDATE` and any `FOR UPDATE` policy — not by discipline. A downstream artifact pins the tuple
`(organization_id, opportunity_id, opportunity_version_id)`, never `opportunity_id` alone, and its FK
is `ON DELETE SET NULL` with a denormalized `title`/`company_name` copy. A `RESTRICT` FK would make
the opportunity undeletable and break account deletion — the `drizzle/0026_deleted_user_sentinel.sql`
bug class.
