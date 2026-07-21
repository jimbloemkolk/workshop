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

# transcriber env, pinned by its OWN uv.lock — packages/transcriber is a self-contained
# uv project (no uv workspace, no path dependency on packages/harvester or the pnpm
# world; verified against its pyproject.toml/uv.lock), so this needs nothing from the
# harvester COPY below. Deliberately ordered ahead of it: `COPY packages/harvester`
# changes on essentially every deploy (any TS edit), which would otherwise bust this
# layer's cache and force a full torch/whisperx re-resolve+download every time. This
# layer only invalidates when packages/transcriber itself changes, which is rare —
# changes-rarely above changes-every-deploy. ct2 runs on plain CPU.
COPY packages/transcriber packages/transcriber
RUN cd packages/transcriber && uv sync --no-dev

COPY packages/harvester packages/harvester

# web app → web/dist, served by the backend (static + SPA fallback). Must stay after
# the harvester COPY above — it builds packages/harvester/web, which lives in it.
RUN pnpm --filter @workshop/harvester-web build

ENV HARVESTER_TRANSCRIBER_BACKEND=ct2 \
    NODE_ENV=production
EXPOSE 4747

WORKDIR /app/packages/harvester/backend
CMD ["pnpm", "exec", "tsx", "src/main.ts", "serve"]
