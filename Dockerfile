FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# CI=true so pnpm's deps-status check can purge node_modules non-interactively
# (avoids ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
ENV CI=true
RUN corepack enable

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
RUN touch .env.docker
COPY server.prod.mjs ./

# Runtime files for drizzle-kit migrate + tsx seeds (Coolify post_deployment_command)
COPY drizzle ./drizzle
COPY drizzle.config.ts ./drizzle.config.ts
COPY tsconfig.json ./tsconfig.json
COPY scripts ./scripts

EXPOSE 3000

# Let Coolify/Docker know when the app is actually serving. The endpoint is
# intentionally shallow (no DB touch) — DB liveness is the db resource's own
# healthcheck. start-period covers the TanStack Start server boot + dist load.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.prod.mjs"]
