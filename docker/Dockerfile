# syntax=docker/dockerfile:1
# App image (Architektura §12.1): Node LTS on Debian slim, non-root. It is built for the platform
# of the building host; D02.2 runs it natively on linux/amd64 and linux/arm64 runners.
# Base image pinned by digest (multi-arch index of node:24.22.1-trixie-slim).
ARG NODE_IMAGE=node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
# pnpm comes from packageManager in package.json; no interactive download prompt in a build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# Download dependencies from the lockfile alone so this layer survives source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm -r build \
 && pnpm --filter @openlife/server deploy --prod /out/server

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Application files stay owned by root and read-only for the runtime user.
COPY --from=build /out/server apps/server
COPY --from=build /workspace/apps/web/dist apps/web/dist
# Source revision of this build for snapshot metadata (apps/server/src/bootstrap/build-info.ts).
ARG BUILD_REVISION=development
RUN printf '{"buildRevision":"%s"}\n' "$BUILD_REVISION" > apps/server/build-info.json
# Mount points of Architektura §15.1. Compose binds the installation folders here (D07); the
# image provides them owned by the runtime user so a container without mounts still starts.
RUN mkdir -p /data/backup /data/logs/app /data/tmp /control/maintenance /instance \
 && chown -R node:node /data /control
USER node
EXPOSE 8080
# start-interval (Docker Engine ≥ 25) probes every 2 s during start-up, so readiness is
# reported within seconds instead of after the first 30 s interval.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "apps/server/dist/main.js", "--host", "0.0.0.0"]
