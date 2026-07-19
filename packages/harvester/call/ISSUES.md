# Issues — implementation session 2026-07-05/06

Friction encountered while building phases 0–6. Recorded so the next
session (or human) doesn't rediscover them the hard way.

## 1. Parallel worktree sessions fight over shared machine state (big)

Another Claude session in `repo.git.void-sonnet` was implementing the same
feature simultaneously. Docker Compose derives its project name from the
directory (`packages/harvester` — identical in every worktree), so its
`compose up` **silently recreated my running containers with its own
livekit.yaml and secrets**. Symptom: tokens my backend minted (and could
verify itself) were rejected by LiveKit with "token signature is invalid" —
locally the HMAC checked out, which made it look impossible. Diagnosis:
`docker inspect harvester-livekit-1 --format '{{json .HostConfig.Binds}}'`
showed the mount pointing at the *other* worktree. The sessions also share
the default `HARVESTER_DATA_DIR` (one SQLite dev DB) and port 4747, which
polluted one crash-test's event timeline. Mitigations if this continues:
`docker compose -p <worktree>`, per-worktree `HARVESTER_DATA_DIR` and
`HARVESTER_PORT`.

## 2. rtc-node `AudioFrame` ignores typed-array view offsets (subtle, costly)

Streaming PCM into `AudioSource` via
`new Int16Array(buf.buffer, offset, n)` published **silence**: AudioFrame
reads the *backing buffer from offset 0*, so every frame re-sent the file's
first (silent) samples. Nothing errored; the bots "spoke", egress recorded
17 s of −91 dB, per-track Whisper hallucinated `***`, the merge/harvest ran
happily, and sonnet honestly skipped the marked span — the first
speaking-bot milestone "passed" every step while testing nothing. Caught by
`ffmpeg -af volumedetect` on the track files. Fix: `.slice()` each frame
(copy to a fresh buffer). Encoded as a warning comment in
`call/src/bots.ts`.

## 3. First "crash test" wasn't one

`TaskStop` on the `pnpm serve` background task killed the pnpm wrapper but
orphaned the tsx child, which kept serving :4747 — the "killed" backend
handled the end-call, so the run proved nothing (and took forensics on
events.jsonl to untangle, muddied further by issue 1). Redo used
`lsof -t | kill -9` on the actual listener pid. Lesson: verify the process
is actually dead (`curl` the port) before trusting a crash test.

## 4. Egress can only write inside the shared volume (by design, but it bit)

The first `e2e --call` sandboxed its data dir in `os.tmpdir()` like the
local e2e does — egress failed with `mkdir /var/folders: permission
denied` because only `HARVESTER_DATA_DIR` is mounted into the container.
The never-silently-partial finalize surfaced it precisely (good), and the
fix was for the e2e to `mkdtemp` *under* the real data dir. Any future
tooling that fabricates call sessions must respect the mount contract.

## 5. Dockerfile cannot cross-build from Apple Silicon

`uv sync` for the transcriber fails on linux/aarch64: `torchcodec` ships
wheels only for `manylinux_2_28_x86_64` (+ mac/win). All JS layers build
fine; the image simply must be built on the x86_64 homelab (or under
`--platform linux/amd64` emulation, slowly). Documented in DEPLOY.md.

## 6. Fresh worktree ≠ working transcriber

`uv run --no-sync transcriber` in this worktree failed with a cryptic
`Failed to spawn: transcriber` — `--no-sync` (correct for runtime) means a
fresh checkout has an *empty* venv and nothing ever installs it. Fix:
`packages/transcriber` setup script (fast thanks to uv's global cache) plus
copying the `.env` (HF_TOKEN, needed for diarization) from a sibling
worktree. `doctor` catches the callable-transcriber part.

## 7. Sandbox restrictions needed repeated escalation

Sandboxed runs broke in four distinct ways before I moved verification
commands out of the sandbox: pnpm install hung on the blocked registry,
tsx couldn't create its IPC pipe under `/tmp` (EPERM), the Docker socket
was denied, and git couldn't take `index.lock` inside the worktree's
shared gitdir. None were code bugs; all looked like tool failures for a
minute each.

## 8. Spike surprises that shaped the code

Cheap to find in the spike, expensive if discovered in phase 3–4:
- the **egress worker joins rooms as a participant** (`EG_…`) — unfiltered,
  every recording start/stop would have looked like a person joining and
  gap derivation would have been garbage;
- webhook `createdAt` is **second-granular** (delivery is sub-second) —
  gap edges can never be finer than ~1 s, hence the conservative 1.5 s
  minimum gap;
- egress `started_at` is ~1 s before audio actually flows — naive t0
  anchoring would skew every mark and segment offset.

## 9. Small time sinks

- `require()` of socket.io-client's **UMD dist build** in a test script
  silently yielded an unusable export — marks "vanished" until switching to
  the ESM build; one full test cycle wasted.
- Backticks in a `git commit -m "…"` heredoc-less message got
  command-substituted by zsh (`` `calling` `` → *command not found*),
  mangling the phase-3 message; amended with quoting.
- Docker Desktop wasn't running (first `docker` call failed against the
  socket); `open -a Docker` + a wait-for-daemon loop before any compose
  work.
- The macOS mic-permission mattered not at all for calls (browser-side
  capture), but local-recording `doctor` still probes avfoundation — fine
  on this machine, will warn on headless boxes.

## 12. End-call `confirm()` looked like a renderer freeze (2026-07-13)

During the visual redesign, every browser-automation run "froze" at the same
step: clicks and script injection timed out right after ending a call, three
runs in a row, which read as a renderer hang and sent the debugging toward
the freshly-changed CSS (an innocent `color-mix()` in a transitioned
box-shadow was replaced on suspicion). The real cause: `endCall` opened a
native `confirm('End the call for everyone?')` — a modal that blocks the
page's event loop, so every subsequent CDP command times out until the
dialog is dismissed (navigation kills it, which is why tabs "recovered" on
reload). Replaced with an inline two-step button (tap → "end for everyone?"
for 4 s → tap), which is calmer on phones anyway. Lesson: native
alert/confirm/prompt are indistinguishable from a hang under automation —
grep for them before suspecting exotic causes.

## 11. Browser negotiation timed out — livekit-client 2.20 vs server v1.8 (2026-07-12)

After the node-ip fix, browser calls *still* failed: signal websocket
connects, the mic track publishes, egress even records — but the client
throws `NegotiationError: negotiation timed out` after 15 s and loops
through rejoins forever (each rejoin restarting egress, so a "failed" call
leaves a trail of short track files). Cause: `web/package.json` pins
`livekit-client ^2.15.0` but the lockfile resolved **2.20.0** (protocol
17), which doesn't complete publisher negotiation against
`livekit-server v1.8` (1.8.4, protocol 15). The client even warns
`v1 RTC path not found. Consider upgrading your LiveKit server version`.
Everything below signaling worked, which made it look like ICE again — it
wasn't. The rtc-node e2e bots (protocol 12) masked this: **again** the one
client shape the e2e can't cover is the one that broke (cf. issue 10).
Fix: compose now runs `livekit/livekit-server:v1.9` (1.9.12). v1.9 also
enforces ≥32-char API secrets, so the dev secret grew a `_dev` suffix
everywhere (livekit.yaml, egress.yaml, compose default, backend/.env,
spike scripts, README). Lesson: the server image tag and the
livekit-client resolution move independently — when touching either,
retest with a real browser, not just the bots.

## 10. Browsers could not connect media — container IP in ICE candidates (post-session)

First real browser test (2026-07-07): the call "sort of starts, then lots of
disconnects" — join and publish succeed over the websocket, then the media
path times out after ~15 s and livekit-client loops through reconnects.
LiveKit auto-detected its **container-internal IP** (`172.19.0.3`) and
advertised it (plus a useless hairpin srflx) as its candidates; the browser's
own candidates arrived **mDNS-obfuscated** (`[remote][filtered] udp4 host
:63002` with empty address in the LiveKit log), unresolvable inside the
container. No workable candidate pair in either direction. The rtc-node e2e
bots masked this all session: they don't obfuscate their host candidates, so
the server-initiated check reached them — **bots are not a browser; the one
client shape the e2e can't cover is the one that broke.** Fix: pass
`--node-ip ${LIVEKIT_NODE_IP:-127.0.0.1}` (compose) so LiveKit advertises a
host-reachable address; the published UDP range maps it into the container.
`127.0.0.1` covers same-device dev; LAN/tailnet IP for real devices
(DEPLOY.md).
