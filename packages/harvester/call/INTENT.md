# Intent — Remote Calling for the Conversation Harvester

## Why this exists

The harvester assumes a laptop at the table. In practice, harvest-worthy
conversations increasingly happen remotely — a phone call while one of us is
on a train. Ordinary phone/WhatsApp calls produce no per-speaker recording,
no timeline metadata, and no way to mark insight moments as they happen.

This is a calling capability that is itself the recording instrument: every
remote conversation between Jim and Jesse flows into the existing harvesting
pipeline (word-level transcription, verbatim no-LLM-rewrite quotes, insight
artifacts from marked regions) with reliable speaker attribution.

## The v1 shape

Browser-based, two-party voice calling as part of the harvester, on
self-hosted infrastructure, that:

1. Lets Jim and Jesse join a call from anywhere via a tokened room link
   (desktop or mobile browser; screen-on is acceptable). Security rides on
   the tailnet — the app is never exposed beyond it.
2. Records each participant's audio track separately on the server.
3. Supports live insight marking during the call as the primary marking
   mode, with post-call marking on the transcript as the secondary mode.
4. Records connection gap spans as explicit metadata, so the harvester knows
   when mutual exchange broke down.
5. Feeds completed calls into the harvesting pipeline automatically.

**Success looks like:** a spontaneous "shall we call?", both click a link,
talk for an hour with a few taps to mark moments, and structured insight
artifacts appear in the harvester with correct speaker attribution — no
manual steps in between.

## Decisions already taken

- **Media stack: self-hosted LiveKit as SFU** — not mediasoup, not P2P.
  Track Egress writes one Opus/Ogg file per participant natively (precisely
  the per-speaker requirement) and fires a webhook on completion. The SDK
  gives automatic reconnect-with-resume after IP switches — the train
  scenario — for free; hand-rolling ICE restarts is the fiddliest part of
  such a system. All media routes through the SFU: a hybrid P2P path would
  double uplink bandwidth exactly when connections are weak and double the
  reconnect domains, to save a few imperceptible milliseconds. QUIC/MoQ
  connection migration was evaluated: browser WebRTC media cannot run over
  QUIC today; accept the few-second resume gap and revisit in ~a year.
- **Node stays the brain; LiveKit is a media appliance.** The backend uses
  `livekit-server-sdk` for room creation, token issuance, and egress
  control, and receives LiveKit webhooks. No custom socket bridge to
  LiveKit — the SDK + webhooks are that bridge.
- **One server, one app.** Everything runs on the same self-hosted machine
  (at least for now): the harvester backend, the LiveKit + egress
  containers, and the transcriber CLI it shells out to. There is no
  handoff protocol between a calling service and the harvester — calling
  is a harvester capability, and the orchestrator invokes the pipeline
  directly.
- **Deployment: Docker Compose** on the existing homelab: the harvester
  app, livekit, egress, redis, behind the existing reverse proxy.
- **Per-speaker tracks replace diarization.** Each track is transcribed
  independently; word-level timestamps merge the tracks into one attributed
  transcript. Stronger attribution than diarization, and it directly serves
  the verbatim-quote rule.
- **Marks are spans, dual-mode on one button.** A quick tap toggles a span
  open/closed; a long press is press-and-hold (release closes) — the clean
  span survives on mobile without demanding a sustained hold on a train.
- **Multiple participants can mark; overlapping spans merge.** Both parties
  can have spans open at once. For harvesting, overlapping spans merge into
  one region — but raw per-participant marks stay distinct in the data
  model; the merge is a derivation, never a mutation.
- **Gap spans are first-class, directional metadata.** Source of truth is
  the signaling plane (webhooks + SDK events), not audio silence. A gap is
  directional — one party's uplink dying does not imply they stopped hearing
  the other. For the harvester, a gap span marks a period where mutual
  exchange broke down: utterances inside or straddling one are not reliable
  responses to each other, and post-gap repair ("you cut out — what I was
  saying was…") makes the *heard* repetition the canonical version. Gap
  spans are purely additive: if event logging fails, the pipeline degrades
  to today's behavior.
- **Tokened links for two known users, no accounts.** The backend issues
  LiveKit access tokens embedded in shareable per-session links. Design
  should not preclude small rooms later but must not pay complexity for it
  now.

## Explicitly not doing

Client-side fallback recording (local MediaRecorder surviving uplink gaps) —
evaluated and deliberately dropped: gaps are handled as metadata, not
recovered audio. No native mobile apps, push-notification ringing, or
background calling: mobile browser with the screen on is the mobile story.
No group calls beyond two, no accounts, no video, no custom media transport
work.

Architecture decisions live in [DESIGN.md](DESIGN.md).
