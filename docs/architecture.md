# Architecture and protocol

```text
Kernel onboarding -> private handoff -> agent CLI -> operator API (4173)
                                            |
Kernel Renderer Platform <-> renderer bridge + fal -> FFmpeg -> MediaMTX
                                                                 |
                                          viewer + read-only HLS (4174)
                                                                 |
                                                   browser (same origin)
```

## Runtime paths

`server/external-renderer.ts` implements renderer installation login, the authenticated query-free
bridge WebSocket, manifest registration, renderer-pinned story start, lease heartbeats, DSS
handling, and correlated command completion. It validates the separate story and room-main
channels. The setup user token is used by the provisioning/stop proxy only; renderer runtime
uses the installation credential. Login tier is derived from the kernel environment.

The bridge currently combines each DSS frame's ordered command groups into one text-to-video
clip and waits for that clip to play before acknowledging its groups. Nonvisual commands become
a transition when necessary. This preserves frame order but does not reproduce a 3D renderer's
exact animation, timing, or voice identity. It does not import local CVD/EVD exports into the kernel.

`src/lib/dss.ts` is the studio's richer shot planner, used by its legacy room/SSE flow. The studio
can render up to three clips concurrently, while `src/lib/render-pipeline.ts` preserves story
positions. The studio's optional character reference mode supports user-supplied HTTPS images
and voice/exact dialogue audio. The bridge uses text mode. These are intentionally separate
protocol adapters; changing one does not prove the other works.

`server/playout.ts` downloads clips, normalizes H.264/AAC, publishes an RTSP timeline, and supplies
hold frames while generation catches up. MediaMTX exposes fMP4 HLS internally. FFmpeg progress
and the configured audience delay estimate playback completion; acknowledgements are not proof
that every individual viewer has watched the clip.

`server/media.ts` only proxies HLS files belonging to a live in-memory playout session. The UUID
in a stream URL is a capability, not a user login. On stop/restart the gateway no longer serves
that session. This is live viewing, without archives, durable sessions, chat, or guaranteed replay.

## Interfaces

Operator API (local only, or bearer-authenticated private Fly/SSH proxy):

| Route | Purpose |
|---|---|
| `GET /api/health` | Provider model names and whether a fal key is configured; never the key |
| `GET /api/config` | Allowlisted service URLs for local studio setup |
| `POST /api/narrative/provision-external-story` | Create private room, inactive story, and resolve distinct channels |
| `POST /api/external-renderer/runs` | Start one bridge worker run; returns 202 while connecting |
| `GET /api/external-renderer/runs/:id` | Run progress/diagnostics |
| `DELETE /api/external-renderer/runs/:id` | Stop worker activity and playout; CLI separately stops the kernel story |
| `POST /api/narrative/stop-show` | Cancel kernel story and leave room using a valid user session |
| `/api/generate`, `/api/playout/*`, other `/api/narrative/*` | Local studio adapter routes |

Public listener: `GET`/`HEAD /` and allowlisted built viewer assets, `GET /healthz`, and `GET`/`HEAD /hls/h3-:session/:file`. Other routes/methods
return 404. Static files are served only from dist/viewer; neither the studio nor the server
source is accessible. Fly/Render derive the public origin from platform metadata; VMs use
PUBLIC_APP_URL set by the agent. Worker and viewer ship together on the chosen host.

## Compatibility and recovery

Reviewed against Story Kernel PR [#6681](https://github.com/PickfordAI/unrendered/pull/6681),
commit `6f0689648228c46f6880349f9e0c888e3076c77c`. The locally running Compose stack's worktree
matches that commit. The protocol is still evolving; rerun a real end-to-end acceptance when
upgrading it. Offline tests cover shape, ordering, retries, and access boundaries, not a complete
kernel deployment or provider acceptance.

There is one active agent run per worker. Run records, queues, and media are ephemeral. Automatic
resume after a process crash is not implemented; stale kernel sessions must be stopped and a new
story started. Retrying `start` is not a durable idempotency guarantee across a network failure.
The CLI saves provisioned identities before renderer start so ordinary failed starts can be
cleaned up. If provisioning itself fails partway, inspect/reconcile the created room through the
kernel onboarding flow before retrying. No automatic synthetic audience traffic is generated.

The integrated studio bridge additionally supports direct MiniMax and local/test routing. It keeps
setup context without video jobs, approximates observed UE controls by timing, and acknowledges
ordered dialogue groups after playout. Authoritative story-status polling distinguishes ended and
failed runs where the caller provides the status origin and setup token. CLI and studio flows remain
separate acceptance surfaces; the integration merge has offline validation only.


## Explicit fal continuity modes

`renderMode=auto` preserves the configured direct MiniMax/fal adapter. Explicit
`fal-turbo-i2v` and `fal-max-ref2v` require a fal credential even when a direct MiniMax key is
present; failures never switch providers. Run settings accept an HTTPS `initialImageUrl`,
`shotPlanner` reference/style settings, `generationConcurrency` (default 2, at most 8), and
`maxBufferedSeconds` (default 30, at most 120).

New modes compile each accepted DSS frame in order into immutable shot/group plans before
submitting its video jobs. Turbo image-to-video requires an initial image and chains each scene's
next shot from the previous clip's last frame. Reference-to-video uses configured character/set
references for the first shot of each camera/continuity setup, then adds that anchor clip's first
frame to later matching shots (the last frame instead when the anchor shot contains movement, preserving its resulting pose). One of the 12 total reference slots is reserved for the continuity anchor before any submissions. Independent camera setups can generate concurrently; dependent
shots wait for their anchor generation/frame extraction, not for playback. Failed anchors fail
their dependents instead of silently removing references.

The scheduler reserves unplayed video duration in playback order, including dependency waits,
so later jobs cannot starve an earlier dependent shot. One shot larger than the configured budget
may occupy an otherwise empty buffer. Generation can overlap playback within the accepted frame;
frames remain serial at story boundaries. Enqueue and group completion stay in DSS order. Control
waits complete before their group acknowledgement; generation progress does not advance the
kernel's sequence high-water mark. Stop aborts provider and frame-extraction jobs and drains them.
A changed assignment terminates the run; it cannot enqueue stale results or silently resume.

The private operator `POST /api/video-frame` extracts first/last continuity frames. The public
viewer cannot call it. Extraction is restricted to the supported fal media CDN, with bounded
size/time and cancellation; resulting JPEG data stays internal to the rendering flow.
These additions have offline mocked validation until separately exercised with real providers.
