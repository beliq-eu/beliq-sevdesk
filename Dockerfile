# =============================================================================
# beliq-sevdesk worker image.
#
# Build context is this directory only. The one runtime dependency, @beliq/sdk,
# is pulled from the public npm registry; no sibling repo is copied in, so no
# private beliq source enters the image. All validation/conversion logic runs on
# the beliq API over HTTPS and is never bundled here.
# =============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Install with devDeps (tsc), build, then prune to production deps so the runtime
# layer carries no build tooling. No committed lockfile: @beliq/sdk resolves from
# the registry, matching the release workflow.
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
  && rm -rf node_modules \
  && npm install --omit=dev

# =============================================================================
# Runtime
# =============================================================================
FROM node:22-bookworm-slim AS runner

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs beliq

WORKDIR /app

COPY --from=builder --chown=beliq:nodejs /build/node_modules ./node_modules
COPY --from=builder --chown=beliq:nodejs /build/dist ./dist
COPY --chown=beliq:nodejs package.json ./

# Default the state file and output dir to mount points the non-root user owns,
# so `-v host:/app/state` and `-v host:/app/out` persist the high-water-mark and
# the converted documents across restarts.
RUN mkdir -p /app/state /app/out && chown -R beliq:nodejs /app/state /app/out

USER beliq

ENV NODE_ENV=production \
    SEVDESK_STATE_FILE=/app/state/state.json \
    SEVDESK_OUTPUT_DIR=/app/out

# ENTRYPOINT is the worker; args pass through, so `docker run <img> --once` runs a
# single poll and `docker run <img>` (no args) loops as a daemon.
ENTRYPOINT ["node", "dist/index.js"]
