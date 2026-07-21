---
name: deploy-staging
description: Deploy the harvester to applepie staging (https://harvester.staging.applepie.company) — branch model, cherry-pick flow, deploy.sh invocation, verification, rollback. Use whenever a harvester change should land on staging.
---

# Deploy harvester to applepie staging

Target: https://harvester.staging.applepie.company — Jesse's own staging tier
(`applepie`) on Jim's homelab, reachable via `ssh root@applepie.diplodocus-decibel.ts.net`
(Tailscale SSH into the dev-hub container; "root" is the container's own userns root,
not host root).

## Branch model — respect it

- **`voip`** — the development branch for harvester/call work. Feature commits land
  here first: granular, one commit per change, authored as Jesse (repo git config
  already set to JesseSchlienkamp-droid / jesse.schlienkamp@me.com) so Jim can revert
  any single change.
- **`deploy-to-lab`** — the "what's running on staging" branch. Deliberately NOT a
  continuation of voip: it sits on main with a squashed app snapshot
  (`b1e3e6e Implement conversation harvester with call recording`) plus the deploy
  scaffolding (`b9a22c9`, adds `packages/harvester/deploy/`). It shares no file
  history with voip.
- **Never `git merge voip` into deploy-to-lab.** Unrelated histories make every
  shared file an add/add conflict, and a merge drags voip's WIP history into the
  snapshot branch (it also resurrects files the snapshot deliberately deleted, e.g.
  `call/DEPLOY.md`). **Cherry-pick individual commits instead** — content applies
  cleanly because the trees match, and each pick stays independently revertible.

## Deploy steps

1. Commit the change on `voip` (single clean commit, Jesse as author).
2. `git checkout deploy-to-lab && git cherry-pick <sha>`
3. Sanity: `pnpm --dir packages/harvester/web run check` (and backend `check` if
   backend code changed).
4. Deploy (run as a background task — the on-box image build takes minutes):
   ```sh
   DEPLOY_PROVISION_SECRETS=0 bash packages/harvester/deploy/deploy.sh harvester
   ```
   What it does: rsyncs `deploy/harvester/` quadlet units + the repo-root build
   context (root manifests, `packages/harvester`, `packages/transcriber`) to
   `/data/apps/applepie/harvester-src`, builds `localhost/applepie-harvester-app`
   NATIVELY on the x86 box (the image bakes `web/dist` in; it cannot build on
   Apple Silicon — torchcodec ships no arm64 wheels), then restarts the
   `harvester-*` systemd user units. `DEPLOY_PROVISION_SECRETS=0` skips the
   interactive secret pass (secrets already exist in the tier's podman store).
   Deploys the LOCAL tree — no push to GitHub required or implied.
5. Only deploy the stack that changed (`harvester`; `caddy` exists too).

## Verify (all three, every time)

```sh
ssh root@applepie.diplodocus-decibel.ts.net 'podman ps --format "{{.Names}} {{.Status}}" | grep harvester-app'
curl -s -o /dev/null -w '%{http_code}\n' https://harvester.staging.applepie.company/          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://harvester.staging.applepie.company/api/sessions  # 200
```

Confirm the new code actually shipped: pull the hashed bundle name from the page HTML
(`grep -o 'assets/index-[^"]*\.js'`), then grep the bundle for a marker string unique
to the change (a new class name, label, etc.). A 200 alone can be a stale bundle.

## Rollback

`git revert <sha>` on `deploy-to-lab` (and on `voip` to keep them consistent), then
re-run step 4. Each cherry-picked commit is a standalone revert unit — that is the
working agreement with Jim.

## Local test loop (before deploying)

No Docker needed for review/label UI testing: run the backend natively
(`HARVESTER_DATA_DIR=<data dir> pnpm --filter @workshop/harvester-backend run serve`,
port 4747; boots without any LiveKit env — calling is simply disabled) and
`pnpm --dir packages/harvester/web run dev` (port 4748, proxies /api). Real session
data lives on the box at `/data/appdata/applepie/volumes/harvester-data/_data`.
