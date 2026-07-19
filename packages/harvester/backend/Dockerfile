# Harvester app image (homelab `app` profile in packages/harvester/docker-compose.yml).
# Build context is the REPO ROOT:
#   docker compose --profile app build
# Node runs the backend from source via tsx (same as dev); the web app is
# prebuilt and served by the backend; the transcriber's Python env is synced
# at build time (ct2 backend — no Apple mlx inside a container).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# uv (owns the transcriber's Python + venv)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Claude Code CLI: the Agent SDK rides its login (see DEPLOY.md for auth)
RUN npm install -g @anthropic-ai/claude-code

RUN corepack enable
WORKDIR /app

# workspace install (harvester packages only)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/harvester/core/package.json packages/harvester/core/
COPY packages/harvester/call/package.json packages/harvester/call/
COPY packages/harvester/backend/package.json packages/harvester/backend/
COPY packages/harvester/web/package.json packages/harvester/web/
RUN pnpm install --filter './packages/harvester/*' --frozen-lockfile

COPY packages/harvester packages/harvester
COPY packages/transcriber packages/transcriber

# web app → web/dist, served by the backend (static + SPA fallback)
RUN pnpm --filter @workshop/harvester-web build

# transcriber env, pinned by its uv.lock; ct2 runs on plain CPU
RUN cd packages/transcriber && uv sync --no-dev

ENV HARVESTER_TRANSCRIBER_BACKEND=ct2 \
    NODE_ENV=production
EXPOSE 4747

WORKDIR /app/packages/harvester/backend
CMD ["pnpm", "exec", "tsx", "src/main.ts", "serve"]
