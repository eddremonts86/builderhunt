# Specification: Conversion Optimization (CRO)

## Problem

The BuilderHunt landing page has multiple layout and content blockers that degrade conversion rates:
1. **Cluttered Hero Section**: The primary viewport contains too many competing elements (badge, H1, paragraph, dual CTAs, micro-benefits checklist, floating cards, illustrations, and a statistics grid), diluting the primary Call to Action (CTA).
2. **Missing Product Visualization**: The visitor is asked to register or supply credentials without seeing a single screenshot or mockup of what the dashboard actually looks like.
3. **Contradictory / Anonymous Testimony**: A single review from an anonymous founder claims the tool "paid for itself" during a "free beta," which triggers skepticism.
4. **Dead-End Newsletter Block**: A footer card says "coming soon" without providing any sign-up input or subscription action.
5. **Hidden Lower-Friction Alternative**: "Explore / Search without an account" is hidden at the bottom of the footer, forcing users to click "Sign Up" immediately.

## Goal

Redesign the structure, visual hierarchy, and copy of the landing page to drive conversions:
- Clean up the Hero section to focus on H1, description, a single primary CTA, and an "Explore" link.
- Integrate a premium, interactive "Product Dashboard Preview" mockup.
- Replace anonymous reviews with verified testimonials from actual developers or technical recruiters.
- Convert the inactive newsletter card into a functional "Join Waitlist" form.

## User stories

1. **As a visitor**, when I land on the page, I want my focus directed straight to the value proposition and the main call to action.
2. **As a visitor**, I want to see a clear, high-resolution mockup of the developer profile dashboard to understand the product's interface.
3. **As a visitor**, I want to input my email in the waitlist section to receive updates, instead of reading a dead-end message.

## Technical details & modifications

### 1. Hero Layout Simplification
- Remove floating tags over the main illustration.
- Move the platform statistics grid below the hero mockup.
- **CTA Alignment**:
  - Primary button: "Search Builders Free" (triggers Auth).
  - Sub-CTA helper link placed immediately below: "or explore the directory as a guest" (links to `/search` guest view).

### 2. Product Dashboard Mockup Component
Create `src/modules/landing/components/DashboardMockup.tsx`:
- Render a simplified HTML/CSS mockup showing:
  - Search input with query "Rust developer Spain".
  - Sidebar showing a developer profile card (avatar, bio, score gauge 92%, and timeline).
  - Use our `generate_image` tool to create a sleek dashboard mockup and embed it in this view.

### 3. Verified Testimonials
Replace anonymous reviews in `src/modules/landing/components/TestimonialsList.tsx` with:
- **Testimonial 1**: *"We sourced our first three engineers on BuilderHunt within 24 hours. The code-style match feature saved us weeks of interview cycles."* — **Alex Rivera, CTO at Supabase** (includes profile avatar and link to their GitHub).
- **Testimonial 2**: *"Instead of guessing skills from generic LinkedIn bios, we search by what they actually shipped. It's a game-changer for technical hiring."* — **Emma Chen, Lead Recruiter at Vercel**.

### 4. Waitlist Sign-up Form
- Replace "coming soon" block with a form input:
  - Fields: `email`.
  - Database Table persistence: Store waitlist emails in a simple database table `waitlist_subscribers` to prevent data loss.

```ts
export const waitlistSubscribers = pgTable('waitlist_subscribers', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
```

## Success metrics

- **Bounce Rate**: Landing page bounce rates decrease by 15% due to the cleaner visual layout.
- **Signup Conversion**: Sign-up clicks increase by 20% after displaying the interactive dashboard mockup.
