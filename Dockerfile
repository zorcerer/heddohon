# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# better-sqlite3 13.0.3 sets `gypfile: false` and has no install script, so npm
# never invokes node-gyp: the package ships eight prebuilt binaries (glibc and
# musl, x64 and arm64, plus macOS and Windows) and picks one at *runtime* from
# `process.report.getReport().header.glibcVersionRuntime`. This toolchain is
# therefore not what makes the common architectures work, and on an
# architecture with no prebuild `npm ci` still succeeds and the failure lands at
# `require()` instead. It is kept for the one case that does use it, an explicit
# `npm rebuild better-sqlite3 --build-from-source`, and costs build time rather
# than image size: the builder stage is not shipped.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Dependencies first: this layer only rebuilds when the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# Reinstall with dev dependencies dropped, so only runtime packages are copied
# into the final image.
RUN npm ci --omit=dev --no-audit --no-fund

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
	PORT=3000 \
	HOST=0.0.0.0 \
	HEDDOHON_DATA_DIR=/data \
	NODE_OPTIONS=--enable-source-maps

# `upgrade` as well as `install`: the base image is rebuilt on its own schedule,
# and a scan of it found six CVEs in libpcre2-8-0 (10.42-1, fixed in
# 10.42-1+deb12u1 by DLA-4772-1). PCRE2 cannot be removed, since grep and
# libselinux1 both depend on it, so it has to be patched instead. Upgrading here
# makes that deterministic rather than dependent on when the base is rebuilt.
RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*

# npm is not part of the runtime. The entrypoint is `node build/index.js`, the
# native dependency is already compiled in the builder stage, and nothing here
# ever shells out to a package manager. Removing it takes npm's own bundled
# dependency tree out of the image: a scan attributed 18 of 24 findings to it,
# including the highest-rated one, none of which are in this project's
# dependency tree (`npm audit --omit=dev` reports zero). Rebuilding on a newer
# Node 22 tag does not help, since npm 10.9.8 bundles the same versions.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
	/usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# The `node` user ships with the base image. Running unprivileged means a
# compromise of the app process cannot write outside the mounted volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "build/index.js"]
