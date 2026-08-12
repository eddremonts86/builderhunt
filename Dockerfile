FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# CI=true so pnpm's deps-status check can purge node_modules non-interactively
# (avoids ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
ENV CI=true
# pnpm 10, pinned — the same major every workflow pins with `pnpm/action-setup`.
#
# `corepack enable` on its own takes corepack's default, which on this image is pnpm 11.21.0
# (measured). pnpm 11 enforces a `minimumReleaseAge` supply-chain policy that pnpm 10 does not, and a
# Dependabot lockfile legitimately contains packages published hours ago — so the build died on
#
#   [ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 17 lockfile entries failed verification
#   ERROR: process "/bin/sh -c pnpm install --frozen-lockfile" did not complete successfully
#
# **Four consecutive production deploys failed this way** on 2026-08-12 — 4c3cb91fa, ffab53b96,
# 498191764 and cffb11710 — while Quality was green on every one of them, because CI pins pnpm 10 and
# this image did not. Every gate passed and nothing shipped, which is the worst shape a pipeline can
# take: `/api/health` kept answering because the *previous* build kept serving.
#
# Pinned here rather than by adding `packageManager` to `package.json`: that is the better
# single-source fix, but `pnpm/action-setup` documents `version` as optional *when* `packageManager`
# exists and does not say what it does when both are set, and nine workflow inputs would be riding on
# the answer. Fixing a dead deploy pipeline is not the moment to find out.
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# --frozen-lockfile makes the image reproducible: it installs exactly what the
# committed lockfile pins and fails loudly if package.json and the lockfile have
# drifted (run `pnpm deploy:preflight` locally to catch that before pushing).
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY . .
RUN pnpm build

FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# The Devpost ingestion worker (plan: devpost-integration) needs a real
# Chromium instance — Devpost has no API and bot-challenges plain server-side
# fetch. `--with-deps` also apt-installs the Debian shared libraries Chromium
# needs (libnss3, libatk1.0-0, libgbm1, libasound2, etc.) that
# node:22-bookworm-slim doesn't ship by default. This meaningfully increases
# image size/build time; the worker itself stays inert unless
# DEVPOST_ENABLED=true is set (see docs/operations/deploy-runbook.md).
RUN npx playwright install --with-deps chromium

RUN touch .env.docker
COPY server.prod.mjs ./
# server/security.mjs is imported by server.prod.mjs at runtime — src/ is not copied into this
# stage, which is why that module lives outside it. Without this line the entrypoint cannot boot.
COPY server ./server

# Runtime files for drizzle-kit migrate + tsx seeds (Coolify post_deployment_command)
COPY drizzle ./drizzle
COPY drizzle.config.ts ./drizzle.config.ts
COPY tsconfig.json ./tsconfig.json
COPY scripts ./scripts

# Editorial content, read from disk at REQUEST time, not bundled at build time:
# `src/shared/lib/blog.ts` does `readdir(join(process.cwd(), 'content', 'posts'))`
# and `scripts/db/sync-platform-content.ts` reads content/changelog + content/roadmap.yml.
# Without this line the directory does not exist in the runtime stage, `readdir`
# throws, the catch returns [], and /blog + /blog/atom.xml are permanently empty
# in production while looking perfectly healthy locally.
COPY content ./content

EXPOSE 3000

# Let Coolify/Docker know when the app is actually serving. The endpoint is
# intentionally shallow (no DB touch) — DB liveness is the db resource's own
# healthcheck. start-period covers the TanStack Start server boot + dist load.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.prod.mjs"]
