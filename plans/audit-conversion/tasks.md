# Tasks: Conversion Optimization (CRO)

## Phase 1: Waitlist Database Setup
- [ ] Create database migration for `waitlist_subscribers` table
- [ ] Update `src/shared/lib/db/schema.ts` with new table configurations

## Phase 2: Mockup Asset & Layout
- [ ] Ensure `public/images/dashboard_mockup.jpg` is committed to the project repository
- [ ] Create `src/modules/landing/components/DashboardMockup.tsx` component loading the mockup image with responsive styling rules
- [ ] Add the mockup component into the central hero section layout in `src/routes/_landing/index.tsx`

## Phase 3: Hero Section & Testimonials Clean-up
- [ ] Simplify hero layout:
  - [ ] Strip floating tags from header section
  - [ ] Update benefits list with refined, non-hyperbolic copies
  - [ ] Add the "Explore as Guest" sub-CTA link below the primary sign-up button
- [ ] Create `src/modules/landing/components/TestimonialsList.tsx` with verified Supabase and Vercel quotes
- [ ] Render the testimonials list inside the social proof section of the landing page

## Phase 4: Waitlist Subscription Form
- [ ] Implement server action `subscribeToWaitlist` verifying email schemas using Zod
- [ ] Create waitlist input form component replacing the "coming soon" block in the footer section
- [ ] Add basic honeypot inputs to waitlist form to block bots submissions

## Phase 5: Verification & Safety
- [ ] Perform local verification checks of waitlist email database persistence
- [ ] Validate image responsiveness and loading tags (lazy-load off for hero mockup LCP)
