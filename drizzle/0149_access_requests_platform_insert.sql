-- Custom SQL migration file, put your code below! --

-- waitlist-launch plan: `builderhunt_platform` gains INSERT on `access_requests`.
--
-- 0147 gave the platform role SELECT and UPDATE on the reasoning that it "reads the queue and records
-- decisions", with INSERT reserved for `builderhunt_app` because the public request form is what
-- creates rows. That was too narrow, and the gap was found the honest way: an operator typed an address
-- into the admin screen's "approve directly" box and nothing happened. The audit trail recorded two
-- `access_request.approve` events with `result: failed` and no row was written.
--
-- Inviting a specific person who never filled in the form is not an edge case in a closed beta — it is
-- the main way the allowlist grows. The alternative to this grant was inserting through the app role and
-- updating through the platform role, two statements across two connections with no transaction
-- spanning them, which trades a narrow grant for a race.
--
-- This does not widen what the platform role can *reach*: it already reads and rewrites every row in
-- this table, including flipping anyone to `approved`. Being able to create the row it would then
-- immediately approve adds no authority it lacked. DELETE is still withheld — a decision must stay on
-- the record.
GRANT INSERT ON TABLE access_requests TO builderhunt_platform;
