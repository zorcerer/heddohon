# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────────────
# On the machine doing the build, whatever the target (`$BUILDPLATFORM`), so an
# arm64 image is not built under emulation. Nothing this stage produces is tied
# to its own architecture: `build/` is JavaScript, and the one native module,
# better-sqlite3, carries the binaries for both targets (see below). Only the
# runtime stage runs as the target, and all it does is install two packages.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder

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

# ── ffmpeg stage ──────────────────────────────────────────────────────────────
# The decoder sound analysis reads audio with (issue #314, part of #312): a
# static ffmpeg with only what that needs, the audio formats a music server
# holds decoded to raw float samples. 4.7MB on amd64, where Debian's ffmpeg
# package adds 647MB to the runtime image; it decodes the same samples, bit
# for bit, at the same speed (measured 2026-11-12 on FLAC and MP3).
#
# Built on the build machine and cross-compiled for arm64, as the builder
# stage avoids emulation: a compile under QEMU takes many times as long.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS ffmpeg
ARG TARGETARCH
ARG FFMPEG_VERSION=7.1.5
ARG FFMPEG_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
RUN apt-get update \
	&& apt-get install -y --no-install-recommends build-essential nasm curl ca-certificates xz-utils \
	&& if [ "$TARGETARCH" = arm64 ] && [ "$(dpkg --print-architecture)" != arm64 ]; then \
		apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross; fi \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
	&& echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
	&& tar xJf ffmpeg.tar.xz --strip-components=1 && rm ffmpeg.tar.xz
# Everything off, then: the file and pipe protocols; the containers and
# decoders of FLAC, MP3, AAC, ALAC, Opus, Vorbis, WavPack, APE, WMA and PCM;
# resampling and the filters the command line needs to reach it; raw float
# output. No network, no external library.
RUN set -e; cross=''; \
	if [ "$TARGETARCH" = arm64 ] && [ "$(dpkg --print-architecture)" != arm64 ]; then \
		cross='--enable-cross-compile --arch=aarch64 --target-os=linux --cross-prefix=aarch64-linux-gnu-'; fi; \
	./configure $cross --prefix=/opt/ffmpeg --disable-everything --disable-doc --disable-ffplay --disable-ffprobe \
		--disable-network --disable-autodetect --disable-avdevice --disable-swscale --disable-postproc \
		--enable-small --enable-static --disable-shared --extra-ldflags=-static --pkg-config-flags=--static \
		--enable-protocol=file,pipe \
		--enable-demuxer=flac,mp3,mov,ogg,wav,aac,matroska,aiff,ape,wv,asf \
		--enable-decoder=flac,mp3,mp3float,aac,aac_latm,alac,opus,vorbis,wavpack,ape,wmav2,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be \
		--enable-parser=flac,mpegaudio,aac,opus,vorbis \
		--enable-filter=abuffer,abuffersink,aresample,aformat,anull,atrim,null,buffer,buffersink \
		--enable-muxer=pcm_f32le --enable-encoder=pcm_f32le --enable-swresample \
	&& make -j"$(nproc)" && make install \
	&& ${cross:+aarch64-linux-gnu-}strip /opt/ffmpeg/bin/ffmpeg
# Built without its GPL parts, so it is under the LGPL 2.1 or later: its
# licence, and where its exact source is, go into the image with it.
RUN mkdir -p /opt/ffmpeg/licenses \
	&& cp COPYING.LGPLv2.1 /opt/ffmpeg/licenses/ \
	&& printf 'ffmpeg %s, LGPL 2.1 or later (COPYING.LGPLv2.1).\nSource: https://ffmpeg.org/releases/ffmpeg-%s.tar.xz\nSHA-256: %s\nConfigured by the ffmpeg stage of the Dockerfile at https://github.com/zorcerer/heddohon\n' \
		"$FFMPEG_VERSION" "$FFMPEG_VERSION" "$FFMPEG_SHA256" > /opt/ffmpeg/licenses/README

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.source=https://github.com/zorcerer/heddohon \
	org.opencontainers.image.description="Server-rendered music player for Navidrome/Subsonic and Jellyfin libraries" \
	org.opencontainers.image.licenses=MIT

# SHUTDOWN_TIMEOUT is how long adapter-node waits for open requests on SIGTERM
# before closing them: under the 10 seconds `docker stop` gives.
ENV NODE_ENV=production \
	SHUTDOWN_TIMEOUT=3 \
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
	/usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
	/opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /opt/ffmpeg/licenses /usr/local/share/licenses/ffmpeg

# The server runs unprivileged, so a compromise of its process cannot write
# outside the mounted volume. It is the entrypoint that gets it there: started
# as root, it gives the data directory to the user the server will run as
# (PUID and PGID, or whoever owns the directory, or the `node` user that ships
# with the base image) and drops to that user before Node starts. A missing
# host directory is created by Docker as root's, and with `USER node` here the
# server could not write it until someone ran `chown` on the host. Started
# with `--user`, the entrypoint has no root and runs the server as that user.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown -R node:node /data /app && chmod 0755 /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "build/index.js"]
