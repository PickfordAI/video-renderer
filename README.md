# Pickford Video Renderer

An open-source renderer for **DSS**, the story format emitted by the Pickford Story Kernel.
It turns ordered story commands into MiniMax H3 video through direct MiniMax or [fal](https://fal.ai), then uses
FFmpeg and MediaMTX to play a continuous HLS stream. It is a standalone repository: no kernel
source code, monorepo packages, or database access is required.

Choose how to watch:

1. **Locally:** the worker and player run on your computer. Only you can access them.
2. **With friends:** the worker and viewer deploy together to your chosen host—Fly.io, Render,
   or a Docker VM on AWS, GCP, or another provider. Share the watch link; your computer can go offline.

The Story Kernel runs separately. A compatible kernel installation, a MiniMax or fal account, and an
onboarding handoff are required to render a live story. You can build and test without any keys.

## Let an agent set it up

Give your agent this repository and [the agent runbook](docs/agents.md). The agent can discover
local Docker ports, consume the kernel's onboarding handoff, configure the worker, start the
story, and return a watch link. The user only chooses where to watch and connects the required
accounts. The agent returns a watch link on the same host; no second hosting tool is needed.
Credentials never enter the viewer or watch link.

## Local quick start

Requires **Node.js 22+**, FFmpeg, and Docker. Start your Story Kernel stack first.

```sh
npm ci
cp .env.example .env
# Set MINIMAX_API_KEY (preferred) or FAL_KEY in .env, or provide it through the process environment.
npm run setup
npm run build
docker compose up -d media-relay
npm start
```

In another terminal:

```sh
npm run doctor
npm run story -- start --handoff /absolute/path/to/handoff.json
npm run story -- status
```

Open the returned `watchUrl`. The first scene can take a few minutes. The agent uses
[the handoff contract](docs/agents.md#handoff-contract) to obtain the episode and renderer
credentials from earlier onboarding steps. `npm run setup` discovers published Docker ports
and writes a private `.renderer/services.json`; it never asks for container IP addresses.
When multiple kernel stacks are running, specify `npm run setup -- --project <compose-project>`.

Stop generation, playout, and the kernel story:

```sh
npm run story -- stop --handoff /absolute/path/to/handoff.json
```

Then stop the worker with Ctrl+C. `docker compose down` stops this repository's relay.
Stopping a story does not delete its room or change another room's state.

## Host for friends

Follow [the deployment guide](docs/deployment.md). **One Docker image serves the worker and
viewer from one HTTPS address.** Choose Fly.io for the included CLI deployment, Render for a
single-service Blueprint, or the Compose/Caddy template for an existing AWS/GCP/Docker VM.
The agent resolves service URLs and returns the watch link automatically.

```sh
# Fly example; FAL_KEY is already available to the agent.
npm run deploy:fly -- --app <existing-fly-app>
npm run hosted:connect
# In another managed terminal:
npm run story -- start --hosted --handoff /absolute/path/to/handoff.json
npm run share -- --hosted
```

Render and VM deployments use the same story/share commands. Vercel remains an optional separate
viewer for existing deployments; it is not required for any of the combined hosting options.

Anyone with a watch link can watch while that story is running. The viewer has playback controls;
it does not expose generation controls, kernel credentials, or audience chat. Hosting and fal
usage are billed by their providers. Stop or destroy an unused hosted worker to stop compute costs.

## Developer studio

`npm run dev` serves the existing studio at `http://localhost:4173`. Use it to inspect DSS,
preview imported CVD/EVD exports, configure your own character references, and render manually.
The studio's legacy room/SSE/chat connection is separate from the agent's renderer-credential
bridge. Use one rendering flow at a time. `/external-run.html` is the advanced protocol test page.
All operator pages stay private; the public listener serves only the viewer and its media.

The studio stores service preferences in localStorage and its user token in sessionStorage.
Agent-started stories keep runtime credentials in worker memory. Handoff files remain wherever
the caller stored them. There are no bundled character portraits or remote voice samples; supply
media you have permission to use. The studio and agent bridge both support explicit Turbo image-to-video and Max reference-to-video
choices. See [generation choices](#generation-choices) for inputs and adapter differences.

For the entire local renderer in Docker, including FFmpeg:

```sh
docker compose --profile full up --build
```

Set `MINIMAX_API_KEY` or `FAL_KEY` in `.env` first. This starts the operator on loopback port 4173 and the viewer/media
port on loopback port 4174. Host-based discovery generates host URLs; when the worker runs inside
Docker, supply `services` in the handoff using `http://host.docker.internal:<published-port>` for
the Show API and **HTTPS** for Renderer Platform, or run the agent bridge worker on the host.
The supported zero-plumbing local agent path is `npm start` plus the relay container.

## Configuration and validation

See [.env.example](.env.example) for optional overrides and [architecture](docs/architecture.md)
for the protocol and process boundaries.

```sh
npm run check          # tests, type checking, studio/server/viewer builds
npm run build:viewer   # standalone viewer artifact; no credentials needed
npm audit
docker compose config --quiet
docker build --target hosted -t pickford-video-renderer .
```

This is an early release with volatile live sessions: worker restarts, deployments, or bridge
failures end the run. Start a fresh story after recovery; there is no durable resume or recording.
One agent renderer run is allowed per worker. See [release checks](docs/releasing.md); `npm run release:source` creates a clean source archive.

## License and contributions

[MIT](LICENSE) for this repository's code and documentation. Third-party components retain their
own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The license does not grant
rights to Story Kernel, user stories, media, provider output, or Pickford trademarks.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

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

## Generation choices

Choose the **model**, **continuity strategy**, **concurrency limit**, and **generation lookahead**
separately in the studio. The private onboarding handoff groups these options in `rendererConfig`:

```json
{
  "rendererConfig": {
    "model": "fal-max-ref2v",
    "continuity": "camera-anchors",
    "concurrency": 2,
    "maxBufferedSeconds": 30
  }
}
```

| Model | Inputs |
|---|---|
| `auto` | Keeps the worker's configured direct MiniMax or fal provider. |
| `fal-turbo-i2v` | H3 Max Turbo image to video through fal. Requires an HTTPS `initialImageUrl`. |
| `fal-max-ref2v` | H3 Max reference to video through fal. Requires scene or character image references; can also use dialogue audio or a voice sample. |

Both explicit fal models require `FAL_KEY`, even if the worker also has a MiniMax key. An empty
reference configuration fails before a generation request; it does not silently switch models.
Turbo does not accept voice references. The renderer does not overlay ElevenLabs audio or add
lip-sync processing. Ref2vid voice conditioning also does not guarantee an exact performance.

| Continuity strategy | Behavior and current support |
|---|---|
| `none` | Independent shots from prompts and configured references. Available for `auto` and Max ref2vid, including manual/imported studio shots. |
| `last-frame-chain` | Each shot starts from the preceding clip's last frame. Currently supported for Turbo i2vid. Generation overlaps playback, with one generation job at a time. |
| `camera-anchors` | Reuses camera setup anchors while independent shots generate in parallel. Currently supported for Max ref2vid in connected StoryKernel runs. |

Unsupported model/strategy combinations fail before generation. The studio keeps a compatible
strategy when the model changes; otherwise it selects and displays that model's supported default.
Camera anchors require the connected bridge. Manual/imported rendering rejects that strategy
instead of ignoring it; select **No frame continuity** for independent Max studio shots.

`rendererConfig.concurrency` defaults to **2** (range 1–8) and remains an independent ceiling.
Last-frame chaining can use only one job regardless of that ceiling because each frame depends on
the preceding output. `rendererConfig.maxBufferedSeconds` defaults to **30** (range 5–120) and
bounds generation lookahead; one shot can exceed the window when necessary to make progress.
Larger buffers smooth playback but delay when audience input can affect the visible story.
Completion acknowledgments correspond to actual playback, not generation finishing.

For connected StoryKernel runs, `shotPlanner` supplies named `characters`, `sets`, optional
`styleImageUrl`/`styleDescription`, `initialImageUrl`, and readable `markNames`. Each character
may include `name`, `aliases`, `description`, `imageUrl`, and
`voice: { "url": "https://…/sample.mp3", "durationSeconds": 4 }`. Use 2–15-second samples.
The planner carries staging forward, binds references to the shot, and prefers usable exact DSS
dialogue audio over a fallback voice sample. The imported/manual studio path uses its existing
shot descriptions and matched character references; camera-aware planning belongs to the bridge.

Old handoffs using top-level `renderMode`, `generationConcurrency`, and `maxBufferedSeconds`
remain accepted. Their default strategies preserve previous behavior: `auto` uses `none`, Turbo
uses `last-frame-chain`, and Max uses `camera-anchors`. Explicit `rendererConfig` fields take
precedence over their legacy aliases. Existing studio preferences migrate the same way.
Generation settings are disabled while a run or job is active. Stop resets continuity state.
