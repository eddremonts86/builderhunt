-- What the app role must be able to see for the handle policies to be real
-- (plan: phase-2/07-perfiles-autogestionados, "Expose strict owner and public profile APIs").
--
-- Found by the route e2e running as the real `builderhunt_app` role — the repository suite connects
-- as a superuser and proved these semantics against a database that hides nothing. Under RLS, three
-- of them were void:
--
--   1. `reserveHandle` uses INSERT ... ON CONFLICT DO UPDATE, which Postgres refuses outright
--      without UPDATE privilege on the table — and `0175` granted the app role SELECT, INSERT,
--      DELETE only. Every reservation was a 500.
--   2. `isHandleAvailable` must see *other people's* live reservations to say "taken", and the
--      owner-only policy made every rival reservation invisible. A held handle read as free, and a
--      profile could be created over somebody's hold.
--   3. The thirty-day handle hold after deletion is enforced by a read: the checker must see that a
--      soft-deleted profile recently held the handle. No policy exposed deleted rows, so the hold —
--      whose whole point is that a released handle inherits its owner's inbound links, which reads
--      as impersonation — did not exist for the role that matters.
GRANT UPDATE ON "self_managed_handle_reservations" TO "builderhunt_app";--> statement-breakpoint

-- Existence is the product feature; the 0175 comment's concern — "publishing who holds what is a
-- list of names worth squatting against" — is about the *surface*, and the only surface is an
-- authenticated, per-user rate-limited lookup that returns a boolean. The row being readable to the
-- app role is what lets that boolean be true.
CREATE POLICY "self_managed_handle_reservations_app_select" ON "self_managed_handle_reservations"
	FOR SELECT TO "builderhunt_app"
	USING (true);--> statement-breakpoint

-- A lapsed reservation may be taken over, and only into the caller's own name. The WITH CHECK is
-- the half that matters: without it, "expired" would let anyone rewrite the row to say anything.
-- The live case never reaches this policy — `reserveHandle` refuses it on the availability read,
-- and a razor-thin race lands on the DO UPDATE's own guard instead.
CREATE POLICY "self_managed_handle_reservations_app_takeover" ON "self_managed_handle_reservations"
	FOR UPDATE TO "builderhunt_app"
	USING ("expires_at" < now())
	WITH CHECK ("reserved_by_user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint

-- Deleted profiles become readable to the app role. Every product query filters `deleted_at is
-- null` already; the one read that must not is the availability check, because a soft-deleted row's
-- single live property is the handle it is still holding. The alternative — keeping deleted rows
-- invisible — is not privacy, it is the thirty-day hold quietly not existing.
CREATE POLICY "self_managed_profiles_deleted_select" ON "self_managed_profiles"
	FOR SELECT TO "builderhunt_app"
	USING ("deleted_at" IS NOT NULL);
