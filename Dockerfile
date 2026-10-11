# media-track self-host image: Next.js app + in-process queue worker
# (started via apps/web/instrumentation.ts). One container = web + worker.
#
# No `# syntax=docker/dockerfile:1` on purpose: this image uses only baseline
# Dockerfile features (multi-stage, COPY --from, ARG), so the external frontend
# buys us nothing — and that directive forces BuildKit to fetch the frontend image
# from Docker Hub at build start, which (a) is the FIRST thing to fail when Hub is
# unreachable and (b) can bypass a configured registry mirror. Dropping it keeps the
# whole build on the mirror once one is set. (See #46.)

# ---- 基础镜像来源 ----
# node:22-slim 来自 Docker Hub,而 **Docker Hub 在中国大陆经常拉不动**
# (`failed to fetch anonymous token: ... EOF` / `connection reset by peer`)。
# 这个 ARG 让墙内用户把它换成公共镜像站,与 docker-compose.yml 的
# DOCKER_MIRROR 共用同一个值:
#
#   docker compose build --build-arg DOCKER_MIRROR=docker.1ms.run web
#   # 或把 DOCKER_MIRROR 写进 .env,compose 会自动传进来
#
# 已实测可用(2026-08-01,大陆直连):
#   docker.1ms.run · dockerproxy.net · docker.m.daocloud.io · hub.rat.dev
#
# **必须在第一个 FROM 之前声明**——FROM 只能引用此前定义的 ARG。
# 且它在每个构建阶段都要重新声明一次(ARG 的作用域到阶段结束)。
ARG DOCKER_MIRROR
ARG NODE_IMAGE=node:22-slim

FROM ${DOCKER_MIRROR:+${DOCKER_MIRROR}/library/}${NODE_IMAGE} AS builder
WORKDIR /app
# Override for faster installs behind slow/blocked registries, e.g.
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
# next.config.ts bakes serverActions.allowedOrigins at BUILD time, but .env is in
# .dockerignore (secrets) so it isn't readable then. Pass this public-only value as a
# build arg. Declared here; exported to ENV only just before the build step (below) so
# changing it doesn't bust the cached npm ci / dependency layers.
ARG MEDIA_TRACK_ALLOWED_ORIGINS
# Install deps first (cached unless the manifests change), then copy source.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/workflow/package.json packages/workflow/
RUN npm config set registry "$NPM_REGISTRY" && npm ci
# Per-commit build stamp (+ a cache-bust for the source COPY below).
#
# Why: self-host deploys silently kept serving OLD code after a `git pull` — #88–#98
# saw five rebuilds in a row ship a stale image (the box ran a July-2 image for a whole
# day). The exact cause was never definitively pinned (the build logs were lost): a live
# rebuild was seen with `COPY . . CACHED` producing a stale image, yet a clean isolated
# repro on the same router showed COPY re-copies changed source correctly — so it may
# have been a transient poisoned build cache, a no-op `git pull`, or a container that
# wasn't recreated. Rather than bet on one cause, the durable fix makes deploys
# SELF-VERIFYING: stamp the built commit into the image as BUILD_COMMIT so
# scripts/deploy.sh can hard-fail when the running container isn't serving HEAD —
# catching ALL of those failure modes whatever the underlying cause.
#
# GIT_SHA doubles as a cache-bust: an ARG cache-misses on first USE (not on its
# declaration), and a cache miss forces every LATER layer to rebuild. Placed after
# `npm ci` (deps stay cached) and before `COPY . .`, it forces a fresh source COPY +
# build whenever the deployed commit changes. Redundant under BuildKit's content-
# addressed COPY, but cheap and correct — and it genuinely protects self-hosters on a
# classic/legacy builder (`DOCKER_BUILDKIT=0`, or very old Docker) where COPY caching IS
# unreliable. Passed per commit by scripts/deploy.sh (build.args → ${GIT_SHA}); an
# unset value defaults to "unknown".
ARG GIT_SHA=unknown
RUN echo "media-track build commit: ${GIT_SHA}" && echo "${GIT_SHA}" > /app/BUILD_COMMIT
COPY . .
# build:web = build:workflow (tsc) + next build apps/web (output: standalone).
# allowedOrigins is baked here — change it ⇒ rebuild (docker compose up -d --build).
ENV MEDIA_TRACK_ALLOWED_ORIGINS=${MEDIA_TRACK_ALLOWED_ORIGINS}
RUN npm run build:web

# runner 阶段要重新声明:ARG 的作用域在 FROM 处结束。
# 漏了它 ${DOCKER_MIRROR} 会展开成空串 → 这一层悄悄回落到 Docker Hub,
# 于是 builder 走镜像站成功、runner 却卡住,报错还发生在构建末尾(最费时间)。
ARG DOCKER_MIRROR
ARG NODE_IMAGE=node:22-slim
FROM ${DOCKER_MIRROR:+${DOCKER_MIRROR}/library/}${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV MEDIA_TRACK_FORK_BUILD=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Standalone traces from the monorepo root → server entry at apps/web/server.js.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# `output: standalone` does NOT bundle public/ — copy it explicitly, else every
# public asset (e.g. /brands/<provider>.svg for the workspace switcher icons) 404s
# and BrandMark falls back to a bare dot (demo on Vercel serves public/ natively).
COPY --from=builder /app/apps/web/public ./apps/web/public
# Admin CLI escape hatch (forgot-password). standalone ships no scripts/ — copy it
# in so `docker compose exec web node scripts/reset-password.mjs <user>` works. The
# script is self-contained (raw pg + scrypt), so it needs no workflow dist (which
# standalone bundles into .next and doesn't expose as a module).
COPY --from=builder /app/scripts/reset-password.mjs ./scripts/reset-password.mjs
# Records the git commit this image was built from. `docker compose exec web cat
# BUILD_COMMIT` tells you exactly which code the running container serves — the host's
# `git rev-parse HEAD` does NOT (a stale image can outlive a pulled HEAD). scripts/deploy.sh
# compares the two and fails loudly on mismatch, so a silent rollback can't slip through.
COPY --from=builder /app/BUILD_COMMIT ./BUILD_COMMIT
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
