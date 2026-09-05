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

The sole frontend is `viewer/`, served on both the local operator listener and public media
listener. The old React room/SSE studio and manual credential form are removed. Renderer runtime
uses the installation-credential bridge only. The remaining private generation/provisioning API
helpers are available for diagnostics; they are not a second user setup flow.

`scripts/onboarding.mjs` resolves a registered handoff path, STORY_HANDOFF_PATH, or the STORY_*
environment bundle for the CLI. `setup` persists only the file path and discovered service URLs.
The browser receives a fixed allowlist of readiness flags, story state and HLS URL. It never
receives the handoff, provider keys, setup token, renderer credentials, or backend diagnostics.
Start/stop stays with the agent; opening the player never starts paid generation.

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
| `GET /api/viewer-status` | Sanitized setup readiness and current playback; private listener only |
| `POST /api/narrative/provision-external-story` | Create private room, inactive story, and resolve distinct channels |
| `POST /api/external-renderer/runs` | Start one bridge worker run; returns 202 while connecting |
| `GET /api/external-renderer/runs/:id` | Run progress/diagnostics |
| `DELETE /api/external-renderer/runs/:id` | Stop worker activity and playout; CLI separately stops the kernel story |
| `POST /api/narrative/stop-show` | Cancel kernel story and leave room using a valid user session |
| `/api/generate`, `/api/playout/*`, other `/api/narrative/*` | Private generation/protocol diagnostics |

Public listener: `GET`/`HEAD /` and allowlisted built viewer assets, `GET /healthz`, and `GET`/`HEAD /hls/h3-:session/:file`. Other routes/methods
return 404. Static files are served only from dist/viewer; neither agent configuration nor server
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
