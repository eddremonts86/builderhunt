-- Custom SQL migration file, put your code below! --

-- Grants and initial rows for `public_surface_indexing` (created in 0082).
--
-- No RLS: this is platform configuration with no owning subject — not tenant or
-- user data — so access is controlled entirely by GRANT, the same reasoning as
-- `status_checks` in 0048 and `abuse_signals`/`session_signals` in 0044.
--
-- `builderhunt_app` needs SELECT because the read is on the request path of every
-- public page the setting governs (/blog, /changelog, /roadmap and their
-- children), plus robots.txt and sitemap.xml. It never writes: a visitor cannot
-- change what search engines are told.
--
-- `builderhunt_platform` gets INSERT and UPDATE — the admin panel upserts a row
-- per surface. Deliberately NO DELETE: removing a row silently reverts a surface
-- to the fail-closed default, which looks identical to "an admin hid it" in the
-- UI but leaves no `updated_by`. Flipping the booleans keeps the audit trail.
GRANT SELECT ON TABLE public_surface_indexing TO builderhunt_app, builderhunt_readonly;
GRANT SELECT, INSERT, UPDATE ON TABLE public_surface_indexing TO builderhunt_platform;
--> statement-breakpoint

-- Seed the three surfaces as hidden. The column defaults are already
-- noindex/nofollow true, and the read path falls back to the same values when a
-- row is missing, so this is belt-and-braces — but an explicit row is what makes
-- the state visible in the admin panel as a real setting rather than as an
-- inferred default.
--
-- ON CONFLICT DO NOTHING so a restore into a database that already carries these
-- rows does not fail, and so an operator who has already flipped a surface to
-- indexable is not silently reverted.
INSERT INTO public_surface_indexing (surface, noindex, nofollow)
VALUES ('blog', true, true), ('changelog', true, true), ('roadmap', true, true)
ON CONFLICT (surface) DO NOTHING;
