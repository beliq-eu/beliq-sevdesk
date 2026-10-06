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
# layer carries no build tooling. The lockfile pins the tree, so the image
# carries the same dependency versions CI gated the tag on.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
  && rm -rf node_modules \
  && npm ci --omit=dev

# =============================================================================
# Runtime
# =============================================================================
FROM node:22-bookworm-slim AS runner

# The npm CLI the base ships is deleted rather than upgraded: it carries tar,
# pacote, sigstore, brace-expansion, ip-address and picomatch advisories (all 11
# of the image's HIGH/CRITICAL findings, including CVE-2026-59873 in tar), and
# the worker never runs it. ENTRYPOINT is `node dist/index.js`, and every npm
# step happens in the builder stage above.
# The base image can sit behind the Debian security pocket, so the patched builds
# are pulled by name. Each is a no-op once the base carries it.
# perl-base (CVE-2026-8376, -13221, -42496, -42497, -48962, -57432, -57433): fixed
# in 5.36.0-7+deb12u4.
# libpcre2-8-0 (CVE-2026-103111): fixed in 10.42-1+deb12u2.
# The worker runs neither: ENTRYPOINT is node, and its regexes run in V8.
RUN apt-get update \
  && apt-get install -y --no-install-recommends --only-upgrade perl-base libpcre2-8-0 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
  && addgroup --system --gid 1001 nodejs \
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
