# syntax=docker/dockerfile:1.7

# ─── Stage 1: dependencies ───────────────────────────────────────────────────
# Install all npm packages. We can't use --omit=dev because runtime-critical
# packages (tsx, grammy, zod, turndown, @modelcontextprotocol/sdk) are
# misclassified as devDependencies in package.json. Pruning would break boot.
FROM node:22-alpine AS deps

WORKDIR /app

# Build deps for any native modules (esbuild/tsx pulls prebuilt binaries on
# alpine, but keeping these covers any future native add-ons cleanly).
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# tini   = proper PID 1 (forwards SIGTERM/SIGINT to Node so the index.ts
#          shutdown handler runs cleanly).
# wget   = HEALTHCHECK probe.
# su-exec = drops privileges in the entrypoint after fixing volume ownership.
RUN apk add --no-cache tini wget su-exec

WORKDIR /app

ENV NODE_ENV=production \
    HEALTH_PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

# Bring in the prepared node_modules and the source.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Non-root user (entrypoint will chown /app/data to it on every start, so
# bind-mounted volumes don't trip over host permissions).
RUN addgroup -S hawkeye && adduser -S hawkeye -G hawkeye \
 && mkdir -p /app/data \
 && chown -R hawkeye:hawkeye /app \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${HEALTH_PORT}/health" || exit 1

# Container starts as root so the entrypoint can chown the volume; the
# entrypoint then exec's into the hawkeye user via su-exec. tini is PID 1
# so signals reach Node, not an npm shim.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "node_modules/.bin/tsx", "src/index.ts"]
