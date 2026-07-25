-- Custom SQL migration file, put your code below! --

-- public-landing-pages plan (Phase 2, "public radars"): `public_radars` is a
-- global, non-tenant table with no RLS by design — `/r/$slug` must resolve a
-- slug to an organization before any principal exists to set
-- `app.organization_id`. Same grant gotcha as 0051's own note: writes go
-- through `publicDb` (the `builderhunt_app` role in production), so the
-- grant has to exist here or every share/unshare write silently fails.
GRANT SELECT, INSERT, DELETE ON TABLE public_radars TO builderhunt_app;
