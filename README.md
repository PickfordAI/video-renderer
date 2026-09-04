# Pickford Video Renderer

A standalone MiniMax H3 video renderer for the Narrative Engine (Story Kernel). This repository
contains its own browser application, Node server, direct MiniMax and fal integrations, FFmpeg playout pipeline, and
local MediaMTX relay. It imports no code or packages from the `unrendered` monorepo.

## External service boundary

The renderer uses only public network interfaces:

- Narrative Engine: room creation/joining, playback mode, show start/stop, and renderer playback state.
- Narrative Authoring: caller-visible CVDs and EVDs.
- Realtime Gateway: authenticated DSS events.
- Chat Messaging: the room WebSocket.
- MiniMax (preferred) or fal: video generation through the server-side proxy.
- Renderer Platform: renderer login, manifest registration, pinned story start, DSS delivery and completion.

The browser sends Narrative Engine, Narrative Authoring, and Realtime requests through narrow
same-origin proxy routes on the renderer server, avoiding browser CORS coupling. Chat remains a
direct browser WebSocket connection. Service URLs and the session token are supplied by the user
in the setup screen; the Narrative Engine is not started or imported by this repository.

For deployed Story Kernel environments, the server also exposes a loopback-only external-renderer
run API at `POST /api/external-renderer/runs`. It logs in through the public renderer endpoint,
connects the query-free bridge WebSocket with a bearer header, registers an immutable manifest,
starts a renderer-pinned story, renders and plays every ordered DSS group, keeps the lease alive,
with optional audience diagnostics disabled by default. Renderer credentials are retained server-side
and omitted from status responses.

Poll `GET /api/external-renderer/runs/<run-id>` for sanitized evidence and stop the connection with
`DELETE /api/external-renderer/runs/<run-id>`. Audience diagnostics, when explicitly enabled, require distinct authoritative room-main
and story-scoped channel IDs.

## How playback works

Incoming DSS dialogue and supported action groups become ordered shots. The Renderer Platform
bridge generates and plays shots serially, reporting each group complete only after playout. The
legacy browser rendering path can run up to three jobs concurrently. FFmpeg normalizes the clips into one continuous
H.264/AAC timeline, publishes it over RTSP to MediaMTX, and every viewer watches the same stable HLS
URL in a single video element. When generation falls behind, the stream holds the last frame rather
than replacing the player.

Direct MiniMax uses `MiniMax-H3-Max` by default and takes precedence when its key is configured.
The optional fal text-only path uses `minimax/h3-max-turbo/text-to-video`. Character-reference mode
is optional and uses `minimax/h3-max/reference-to-video`. The bundled Whispers portraits and voice
samples are editable defaults; only media matched to a shot is sent to fal.

## Local development

Requirements:

- Node.js 22+
- FFmpeg available as `ffmpeg`
- Docker for the local MediaMTX relay
- A MiniMax API key or fal API key
- Separately running or remotely hosted Narrative Engine services

Set up and start the renderer:

```bash
cp .env.example .env
# Put MINIMAX_API_KEY (preferred) or FAL_KEY in .env.
npm ci
docker compose up -d media-relay
npm run dev
```

Open `http://localhost:4173`. Do not open `index.html` through a `file://` URL—the Node process
serves both the Vite application and the renderer's server-side API.

The setup screen defaults to the standard local Narrative Engine stack:

| Service | URL |
|---|---|
| Narrative Engine / Show API | `http://localhost:8081` |
| Narrative Authoring API | `http://localhost:8091` |
| Realtime Gateway | `http://localhost:8092` |
| Chat Messaging | `http://localhost:8080` |

Use **Create & start show** for a new room or **Join existing room** for a room started elsewhere.
The create flow creates the room, joins it as host, selects `external_renderer` playback, starts the
chosen EVD, and connects DSS and chat. A verified user session token and a Narrative Engine EVD UUID
are required. **Load my shows** retrieves available EVDs from Narrative Authoring.

The session token is kept in `sessionStorage`; endpoint preferences are kept in `localStorage`.
`MINIMAX_API_KEY`, `FAL_KEY`, and renderer credentials remain on the server and never enter the browser bundle.

Stop local services with:

```bash
docker compose down
```

## Containerized renderer

To run both the renderer and relay in containers:

```bash
# Configure MINIMAX_API_KEY or FAL_KEY in .env first.
docker compose --profile full up --build
```

When the Narrative Engine stack runs on the host, use `http://host.docker.internal:<port>` for the
three HTTP service URLs in the renderer setup screen. Chat is opened by the browser, so its URL can
remain `http://localhost:8080`. `MEDIA_RELAY_PUBLIC_HLS_BASE_URL` can override the browser-visible
relay origin when the viewer is not on the Docker host.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FAL_KEY` | optional fallback | Server-side fal credential |
| `MINIMAX_API_KEY` | preferred | Server-side direct MiniMax credential; takes precedence over fal |
| `MINIMAX_VIDEO_MODEL_ID` | `MiniMax-H3-Max` | Direct MiniMax text-to-video model |
| `MINIMAX_REFERENCE_VIDEO_MODEL_ID` | `MiniMax-H3` | Direct MiniMax reference-to-video model |
| `PORT` | `4173` | Renderer HTTP port |
| `FAL_VIDEO_MODEL_ID` | `minimax/h3-max-turbo/text-to-video` | Text-only model |
| `FAL_REFERENCE_VIDEO_MODEL_ID` | `minimax/h3-max/reference-to-video` | Reference model |
| `FAL_QUEUE_BASE_URL` | `https://queue.fal.run` | fal queue origin |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable |
| `MEDIA_RELAY_RTSP_BASE_URL` | `rtsp://127.0.0.1:8554` | Server-side relay ingest |
| `MEDIA_RELAY_HLS_BASE_URL` | `http://127.0.0.1:8888` | Browser-visible HLS origin |
| `MEDIA_RELAY_AUDIENCE_DELAY_SECONDS` | `3` | Estimated HLS audience delay |

## Validate

```bash
npm test
npm run typecheck
npm run build
docker compose config
```

The production image includes FFmpeg and serves the compiled browser and Node application on port
4173.


## Hackathon rendering limits

The MiniMax bridge generates dialogue and supported character actions. Set/character setup is
retained as prompt context and does not submit video jobs. Observed StoryKernel title, credits,
cutscene, fade, debug/FPS, depth-of-field and audio-channel controls use a timing-only approximation:
the bridge waits for their declared duration but does not reproduce Unreal overlays, camera effects,
or separate audio tracks. Unknown commands fail explicitly, including in mixed dialogue groups.
Stop cancels transition waits and suppresses subsequent completion reports.


## Connect a local StoryKernel renderer

In `.env`, configure `RENDERER_PLATFORM_BASE_URL`, `RENDERER_PLATFORM_WEBSOCKET_URL`,
`RENDERER_PLATFORM_ENVIRONMENT=local`, and the provisioned `RENDERER_ID`,
`RENDERER_CREDENTIAL_ID`, `RENDERER_CLIENT_SECRET`, and `RENDERER_VERSION`. The version must be
compatible with the selected story's assets. `RENDERER_REGISTER_MANIFEST=false` reuses an existing
manifest; otherwise registration requires permission and an unused immutable version. Use
`host.docker.internal` when the renderer runs in Docker and StoryKernel runs on the host; use
`localhost` for a native Node renderer. These services and credentials are provisioned separately.

Open `http://localhost:4173`, enter the Narrative Engine/Authoring/Realtime service URLs and a user
session token, load an accessible EVD, and choose Create & start. The bridge prepares a fresh room,
inactive story and story channel, then starts it pinned to this renderer. Watch the local HLS player;
press Stop to stop the upstream story and cancel local generation/playout. Local cancellation still
runs if the upstream Stop request fails. Terminal failures and ended stories clear the live UI state.
