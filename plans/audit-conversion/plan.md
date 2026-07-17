# Plan: Conversion Optimization (CRO)

## Goal recap

Optimize the landing page structure to reduce clutter, integrate the visual product mockup `dashboard_mockup.jpg`, introduce authenticated tech testimonials, create a waitlist database schema to avoid dead-ends, and highlight guest exploration options.

## Why this is a valuable addition

1. **Establishes Immediate Trust**: Adding a high-fidelity image of the product (`public/images/dashboard_mockup.jpg`) proves the product is real and operational, capturing developer interest instantly.
2. **Reduces Friction**: Sourcing tools often hide guest search features to force signups. By providing a clear guest search pathway ("explore as guest"), we decrease bounce rates and demonstrate value before registration.
3. **Credibility Booster**: Replacing generic beta comments with verified, named software engineers and CTO testimonials matches the high design standards of premium platforms.

## Phases

### Phase 1: Waitlist Database Setup
- Create a migration to add the `waitlist_subscribers` table to store emails.
- Export the table definition in `src/shared/lib/db/schema.ts`.

### Phase 2: Asset Management
- Verify that `public/images/dashboard_mockup.jpg` exists in the local directory (done: copied from artifact).
- Configure responsive styling rules to render this mockup cleanly below the main hero titles.

### Phase 3: Hero Section Simplification & Testimonials
- Edit `src/routes/_landing/index.tsx`:
  - Strip floating badge labels from the hero illustration layout.
  - Simplify benefits checklist to 3 key items:
    - "No CV-cliches: search by public code contributions."
    - "De-duplicated profiles across 12 tech networks."
    - "Free guest exploration and query alerts."
  - Reposition the "Explore as Guest" sub-CTA link below the main auth button.
  - Replace the old testimonials block with `TestimonialsList.tsx` rendering Supabase and Vercel verified quotes.

### Phase 4: Waitlist Server Function & Form
- Create a server action `subscribeToWaitlist({ email })` that validates inputs and inserts them into the `waitlist_subscribers` table.
- Build the email submission input form at the bottom footer section, replacing the text block "coming soon".

### Phase 5: Verification & Tests
- Check waitlist database storage by running a local form submission test.
- Verify image dimensions: ensure LCP targets remain fast by sizing `dashboard_mockup.jpg` using `width` and `height` CSS constraints.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Waitlist database spam** | Medium | Medium | Validate email syntax using Zod schemas. Add basic honeypot inputs to prevent automated script submissions. |
| **Heavy page load due to mockup image** | Low | Medium | Compress the image and lazy-load it if it falls below the initial viewport fold, or use responsive `srcset` formats. |

## Rollback plan

- Keep the waitlist routing and database functions self-contained. The landing layout can fallback to static CTA buttons if the server action encounters runtime exceptions.
