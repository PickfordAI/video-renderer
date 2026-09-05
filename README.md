# Pickford Video Renderer

An open-source player for **DSS**, the story format emitted by the Pickford Story Kernel.
The worker turns story commands into MiniMax H3 video through direct MiniMax or [fal](https://fal.ai), then uses
FFmpeg and MediaMTX to play a continuous HLS stream.

There is **one interface** for local and hosted viewing. Your agent connects the accounts,
configures the worker, and starts the story. The page shows setup status and playback;
there are no credential, IP address, service URL, or episode ID forms.

Choose how to watch:

1. **Locally:** everything in this renderer runs on your computer and is visible only to you.
2. **With friends:** worker and viewer deploy together to Fly.io, Render, or a Docker VM on
   AWS, GCP, or another provider. Your agent returns a watch link.

The Story Kernel runs separately and supplies the story and renderer installation credentials.
A MiniMax or fal account and compatible kernel onboarding are required for live generation. You can
build and test without keys.

## Let an agent set it up

Give the agent [the runbook](docs/agents.md). You choose local or hosted viewing and connect your
accounts. The agent obtains the onboarding handoff, supplies the environment, discovers local
Docker services or resolves hosted URLs, and returns the player. Secrets stay server-side.

## Local setup — agent or developer

Requires **Node.js 22+**, FFmpeg, and Docker, with a compatible Story Kernel stack running.

```sh
npm ci
# The agent supplies MINIMAX_API_KEY or FAL_KEY through the environment or a private .env.
# Register the private handoff from earlier kernel onboarding once:
npm run setup -- --handoff /absolute/path/to/handoff.json
npm run build
docker compose up -d media-relay
npm start
```

Open [the local player](http://localhost:4173). It shows which account connections the agent
still needs to finish. In another managed terminal:

```sh
npm run doctor
npm run story -- start
npm run story -- status
npm run story -- stop
```

The player follows the agent-started story automatically. The agent should wait for playable
video before declaring the story ready; the first scene can take a few minutes. Starting a
story submits paid video jobs when DSS arrives. Stop also cancels the kernel story using the
onboarding user session. Stop the worker with Ctrl+C when finished.

`setup` discovers published Docker ports and stores them privately in `.renderer/services.json`.
If multiple kernel stacks are running, the agent selects the matching `--project`. It stores
only a path to the handoff in `.renderer/onboarding.json`; the handoff remains in its original
private location. Neither file is included in Git or Docker builds.

## Environment-based onboarding

The agent can set **STORY_HANDOFF_PATH** instead of registering a file, or supply the identity
bundle entirely through environment variables:

```dotenv
FAL_KEY=<from the user's fal account>
STORY_EVD_ID=<from story authoring>
STORY_SETUP_TOKEN=<from kernel login>
STORY_RENDERER_ID=<from renderer installation>
STORY_CREDENTIAL_ID=<from renderer installation>
STORY_CLIENT_SECRET=<from renderer installation>
```

These are agent/server variables, never browser inputs. See [.env.example](.env.example) for
service overrides and optional story settings. Do not put real values in prompts, logs, or Git.
With this approach, run `npm run setup`, then use the same start/status/stop commands. Restart
the worker after changing `.env`; changes to a registered handoff are read on the next command.
The agent obtains or refreshes account access through the supported onboarding flow.

## Host for friends

[The deployment guide](docs/deployment.md) includes Fly CLI deployment, a single-service Render
Blueprint, and a Compose/Caddy template for AWS/GCP/other Docker VMs. Each serves the same player
and HLS stream from one HTTPS origin. The agent configures deployment plumbing.

```sh
npm run deploy:fly -- --app <existing-fly-app>
npm run hosted:connect
# In another managed terminal with the agent's registered handoff or environment:
npm run story -- start --hosted
npm run share -- --hosted
```

Hosted workers must reach HTTPS kernel services. The setup user credential remains with the
agent; only the runtime installation credential is sent to the worker. The public page receives
only the watch link and media. Opening the public root without a link does not reveal active
stories or account setup status. Vercel is an optional standalone build of the **same player**.

Anyone with the watch link can watch and submit audience suggestions while the story runs. The
renderer relays messages through its authenticated Story Kernel connection; credentials never
enter the page. Treat the watch link as permission to participate. Hosting and fal usage are billed by
their providers. Sessions are volatile: restarts or deployments end the run. One active story
is supported per worker; durable resume and recording are not included.

## Development and verification

The only frontend source is `viewer/`. Both worker listeners serve its built files. The private
local listener adds a read-only status endpoint; the public listener exposes player assets,
live media, and same-origin audience chat for the active story. The retired `/external-run.html` address redirects to the player locally.
The former React studio and manual credential form have been removed.

```sh
npm run check          # protocol/configuration tests, type checking, player/server builds
npm run dev            # build player and watch the server for changes
npm run build:viewer   # standalone player artifact
npm audit
docker compose config --quiet
docker build --target hosted -t pickford-video-renderer .
npm run release:source
```

Rebuild after editing `viewer/`. Protocol details and limitations: [architecture](docs/architecture.md).
Release checklist: [releasing](docs/releasing.md).

The full local Docker profile is available with `docker compose --profile full up --build`.
Supply MINIMAX_API_KEY or FAL_KEY in `.env`. The supported automatic discovery path runs the agent and `npm start`
on the host with the relay in Docker; a container worker needs kernel services reachable from
inside Docker, supplied by the agent.

## License and contributions

[MIT](LICENSE) for repository code and documentation. Dependencies retain their own licenses;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The license does not grant rights to the
Story Kernel, stories, generated media, provider output, or Pickford trademarks.

[Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md)


## Generation choices

The agent configures generation in the private onboarding handoff. Model choice, continuity,
concurrency, and generation lookahead remain separate:

```json
{
  "rendererConfig": {
    "model": "fal-max-ref2v",
    "continuity": "camera-anchors",
    "concurrency": 2,
    "maxBufferedSeconds": 30
  },
  "shotPlanner": {
    "sets": {
      "hotel lobby": { "imageUrl": "https://example.com/approved-lobby.jpg" }
    }
  }
}
```

Replace the example image with an authorized, accessible reference. Settings are read for the
next run; changing configuration does not start generation.

| Model | Required inputs and available continuity |
|---|---|
| `auto` | Uses the configured direct MiniMax/fal adapter with `none`; retains serial generation. |
| `fal-turbo-i2v` | HTTPS `initialImageUrl`; `last-frame-chain` uses each clip's ending frame for the next. |
| `fal-max-ref2v` | Scene or character images in `shotPlanner`, or `initialImageUrl`; choose `camera-anchors` or `none`. |

Explicit fal models require `FAL_KEY` and never switch providers after a failure. Unsupported
model/strategy combinations fail before story provisioning. Turbo cannot use voice references;
no ElevenLabs mixing or lip-sync correction is added. Max can use the beat's raw 2–15-second
DSS audio URL, with an optional voice sample as fallback. Reference conditioning does not guarantee
an exact voice or performance.

`shotPlanner` also accepts named `characters`, `sets`, `styleImageUrl`, `styleDescription`,
`markNames`, and `initialImageUrl`. Character entries may contain `name`, `aliases`, `description`,
`imageUrl`, and `voice: { "url": "https://example.com/voice.mp3", "durationSeconds": 4 }`.
DSS supplies dialogue and staging; it does not necessarily supply character portraits or set images.
The compiler carries blocking, strips spoken TTS tags into acting directions, and anchors style to
a set/style image. Ordinary `talking` animations preserve camera anchors; movement invalidates them.

The concurrency ceiling defaults to 2 (range 1–8). Last-frame dependencies serialize Turbo
regardless of that ceiling. `maxBufferedSeconds` defaults to 30 (range 5–120) and counts all reserved,
unplayed work, including pending and generating clips. Eight eight-second jobs need at least 64
seconds of budget. One oversized shot may occupy an otherwise empty budget to make progress.
This setting is not a startup buffer or permission to submit a batch.

Explicit fal modes can generate future received DSS while earlier clips play. Camera anchors
persist across payloads; media and completion acknowledgements remain in story order. The kernel
must supply enough lookahead. Playback begins with one ready clip to support short and ACK-gated
stories. Offline overlap does not prove sustained live realtime performance or visual quality.

Environment onboarding supports `STORY_RENDERER_CONFIG_JSON`, `STORY_SHOT_PLANNER_JSON`, and
`STORY_INITIAL_IMAGE_URL` for the same options. Existing handoffs with top-level `renderMode`,
`generationConcurrency`, and `maxBufferedSeconds` remain accepted; explicit `rendererConfig`
fields take precedence. Stop the active run before changing its settings.

## Hackathon rendering limits

Dialogue and supported character actions become generated video. Set and cast setup becomes prompt
context. Titles, credits, cutscenes, fades and supported engine controls are timing approximations;
they do not reproduce Unreal overlays or separate audio tracks. Unknown commands fail explicitly.
Stop cancels local generation/playout; the CLI separately stops the kernel story and records any
cleanup that must be retried.
