# Pickford Video Renderer

A standalone MiniMax H3 video renderer for the Narrative Engine (Story Kernel). This repository
contains its own browser application, Node server, fal integration, FFmpeg playout pipeline, and
local MediaMTX relay. It imports no code or packages from the `unrendered` monorepo.

## External service boundary

The renderer uses only public network interfaces:

- Narrative Engine: room creation/joining, playback mode, show start/stop, and renderer playback state.
- Narrative Authoring: caller-visible CVDs and EVDs.
- Realtime Gateway: authenticated DSS events.
- Chat Messaging: the room WebSocket.
- fal: MiniMax video generation through this app's server-side proxy.

The browser sends Narrative Engine, Narrative Authoring, and Realtime requests through narrow
same-origin proxy routes on the renderer server, avoiding browser CORS coupling. Chat remains a
direct browser WebSocket connection. Service URLs and the session token are supplied by the user
in the setup screen; the Narrative Engine is not started or imported by this repository.

## How playback works

Incoming DSS command groups become ordered shots. Up to three fal jobs may run concurrently, but
completed clips wait for their story position. FFmpeg normalizes the clips into one continuous
H.264/AAC timeline, publishes it over RTSP to MediaMTX, and every viewer watches the same stable HLS
URL in a single video element. When generation falls behind, the stream holds the last frame rather
than replacing the player.

Text-only rendering uses `minimax/h3-max-turbo/text-to-video` by default. Character-reference mode
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
`FAL_KEY` remains on the renderer server and never enters the browser bundle.

Stop local services with:

```bash
docker compose down
```

## Containerized renderer

To run both the renderer and relay in containers:

```bash
export FAL_KEY=key_id:key_secret
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
