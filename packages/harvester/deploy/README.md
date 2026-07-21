# Deploy — Applepie stack (caddy + harvester)

Quadlet unit definitions + a deploy script for the `applepie` tier's **caddy** and **harvester**  stacks.

## What's NOT here

**`dev-hub`** — the tier's tailnet machine, pod, and podman/systemd access login
rides on — is infrastructure scaffolding provisioned once.


## Build context — why harvester-app.build needs a second, bigger sync

`caddy.build` is self-contained (an xcaddy `Containerfile`, no external context).
`harvester-app.build` isn't: `backend/Dockerfile`'s own header says its build context is
the **repo root** (it `COPY`s the root `package.json`/`pnpm-lock.yaml`/
`pnpm-workspace.yaml` plus `packages/harvester/**` and `packages/transcriber/**`). So
`deploy.sh` does two syncs, not one:

- the small one: this `deploy/` dir → `/data/apps/applepie/{caddy,harvester}/` (unit
  files + config, same as every other stack in this fleet)
- the bigger one: the repo-root subset the Dockerfile actually needs →
  `/data/apps/applepie/harvester-src/` (source `harvester-app.build`'s
  `SetWorkingDirectory` points at)

Built **natively on the box** (the lab is x86_64, not cross-build from an Apple-Silicon Mac: the transcriber's `torchcodec`
dependency ships no linux/aarch64 wheels), so no `--platform` flag, no registry, no push
— just sync + `systemctl --user restart`, same as caddy.

## Deploy

```sh
cd packages/harvester/deploy
./deploy.sh              # everything (caddy + harvester)
./deploy.sh caddy        # just one stack
./deploy.sh harvester
```

First deploy of a fresh `applepie` tier: `dev-hub` (server-config) has to exist first —
see that repo's `homelab/quadlet/applepie/dev-hub/README.md`.

## Secrets

Same podman-secret-store model as the rest of this fleet: each unit declares what it
needs via `Secret=<name>,...`; `deploy.sh` checks the tier's store and prompts
interactively for anything missing (hidden input, piped over SSH stdin, never written to
disk or committed). Needed here: `applepie-cf-api-token` (Cloudflare, scoped to the
`applepie.company` zone only), `harvester-livekit-api-secret`, `harvester-hf-token`.
