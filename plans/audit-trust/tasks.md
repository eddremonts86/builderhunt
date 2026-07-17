# Tasks: Trust & Security Enhancements

## Phase 1: Database Setup
- [ ] Add `isDeindexed` column to `builders` schema inside `src/shared/lib/db/schema.ts`
- [ ] Run migration generating the new DB column
- [ ] Update search queries in `src/lib/search.ts` to exclude de-indexed rows

## Phase 2: Copy Re-writes & Pricing Component
- [ ] Update H1, headlines, and benefit copies in `src/routes/_landing/index.tsx`
- [ ] Create `src/modules/landing/components/PricingTable.tsx`
- [ ] Render the Pricing Table component inside the landing section index

## Phase 3: Token Security Modal
- [ ] Create `src/modules/landing/components/TokenSecurityModal.tsx` containing encryption details
- [ ] Link trigger help icons next to GitHub token inputs in search and setup dashboard components

## Phase 4: Opt-Out Removal Pipeline
- [ ] Create route file `src/routes/privacy/remove.tsx`
- [ ] Build the de-indexation request form
- [ ] Write server function `requestDeindexing` and email verification routine
- [ ] Write server function `confirmDeindexing` updating `isDeindexed = true` and scrubbing profile fields

## Phase 5: Verification & Tests
- [ ] Verify that de-indexed profiles do not appear in searches
- [ ] Verify security modal link triggers and renders correctly on mobile resolutions
