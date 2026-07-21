# applepie ops-monitoring dashboard image. Build context is the REPO ROOT (same
# convention as harvester/backend/Dockerfile), but the package itself has no build
# step (no vite/react — plain HTML/CSS/vanilla JS in public/) and no workspace deps
# (no @workshop/harvester-core, no drizzle, no Agent SDK), so this Dockerfile is
# deliberately tiny next to the backend's: no ffmpeg (no audio), no uv (no Python),
# no Claude Code CLI (no Agent SDK login) — just node + the two runtime deps
# (fastify, @fastify/static) and tsx to run the TS server directly, same as harvester
# backend's own "run via tsx, don't tsc build" pattern.
FROM node:22-bookworm-slim

RUN corepack enable
WORKDIR /app

# workspace install (dashboard package only) — frozen-lockfile against the repo's own
# pnpm-lock.yaml, so the image always gets exactly what's committed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/dashboard/package.json packages/dashboard/
RUN pnpm install --filter './packages/dashboard' --frozen-lockfile

COPY packages/dashboard packages/dashboard

EXPOSE 5151

WORKDIR /app/packages/dashboard
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
