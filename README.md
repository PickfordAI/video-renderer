# Pickford Video Renderer

An open-source player for **DSS**, the story format emitted by the Pickford Story Kernel.
The worker turns story commands into MiniMax H3 video through direct MiniMax or [fal](https://fal.ai), then uses
FFmpeg and MediaMTX to play a continuous HLS stream.

There is **one interface** for local and hosted viewing. Sign in to Pickford on the local page,
enter your own fal key there, pick a **StoryBundle**, and press Play. The page never asks for an
IP address, a service URL, or an episode ID, and your fal key never leaves your machine.

A **StoryBundle** is a published episode of one of your Pickford stories. (The API still calls it
an EVD; the field names have not changed.)

Choose how to watch:

1. **Locally:** everything in this renderer runs on your computer and is visible only to you.
2. **With friends:** worker and viewer deploy together to Fly.io, Render, or a Docker VM on
   AWS, GCP, or another provider. Your agent returns a watch link.

The Story Kernel runs separately and holds your stories. A fal (or MiniMax) account is required for
live generation; you can build and test without keys.

## Quick start

Requires **Node.js 22+**, FFmpeg, and Docker.

```sh
npm ci
npm run build
docker compose up -d media-relay
npm start
```

Open [the local player](http://localhost:4174) and:

1. press **Sign in with Pickford** — the renderer opens Pickford's own sign-in page and comes back
   to a loopback address it serves itself;
2. paste your **fal API key** and save it. It is written to `.renderer/fal.json` with mode `0600`,
   sent only to fal, and never shown again — the page only says whether a key is present;
3. pick a **StoryBundle** and press **Play**. Press **Stop** to cancel its exact assigned Pickford
   story through your OAuth connection, then stop local generation and playback. Bundles whose
   images are still generating appear as *Preparing images…* and become playable on their own.
   Each click starts a new story; Pickford first cancels and releases any previous Story Run still
   assigned to this renderer installation.

The first scene can take a few minutes; the page shows an estimate. Playing a StoryBundle submits
paid video jobs to fal. The renderer targets Pickford production at `pickford.ai` by default.
Developers using another environment add `STORY_ENVIRONMENT` and matching API, web, and chat URL
overrides to their private configuration. `npm run auth -- status` prints the same status from a
terminal, and `npm run auth -- logout` signs out and clears the stored tokens.

Your Pickford account needs the **creator** role for the renderer to list and play your
StoryBundles; a Pickford admin grants it. The renderer stays signed in on its own: access tokens
last 12 hours and it refreshes them silently, within a grant that lasts 90 days.

The private operator listener remains at `http://localhost:4173`.

## Advanced: agent-managed setup

An agent can instead configure the renderer from an onboarding handoff and drive the story from the
CLI. Give it [the runbook](docs/agents.md). Register the handoff once with
`npm run setup -- --handoff /absolute/path/to/handoff.json`, then:

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
STORY_TYPE=MINIMAX
```

These are agent/server variables, never browser inputs. See [.env.example](.env.example) for
service overrides and optional story settings. Do not put real values in prompts, logs, or Git.
With this approach, run `npm run setup`, then use the same start/status/stop commands. Restart
the worker after changing `.env`; changes to a registered handoff are read on the next command.
The agent obtains or refreshes account access through the supported onboarding flow.

## Opaque story starts

Set `"startMode": "opaque"` in the handoff to skip room and story provisioning. The CLI sends only
the EVD to Story Kernel's renderer-initiated start, which allocates the story and returns an
opaque `storyRunId` plus a shareable `audienceJoinUrl`; `npm run story -- status` shows both along
with the resolved `storyId`. The default `legacy` mode is unchanged.

During an opaque start, transient gateway/transport failures are retried for up to
180 seconds using the same start identity while the renderer stays connected. The
same window also retries transport and 5xx failures while resolving the accepted
run through the audience exchange, reusing its opaque audience handle. `status`
remains `connecting` until both steps succeed. Stop cancels recovery immediately.
If recovery expires, the kernel may still own the run; use
the saved status and kernel account to reconcile it before starting a new story.

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
only the watch link and media. A hosted public root without a link does not reveal active stories
or account setup status; the bare loopback-only local root deliberately follows its worker's active
story. Vercel is an optional standalone build of the **same player**.

Anyone with the watch link can watch and submit audience suggestions while the story runs. The
renderer relays messages through its authenticated Story Kernel connection; credentials never
enter the page. Treat the watch link as permission to participate. Hosting and fal usage are billed by
their providers. Sessions are volatile: restarts or deployments end the run. One active story
is supported per worker; durable resume and recording are not included. If a later renderer
request fails after at least one clip completed, the worker keeps the existing HLS playout
available until the run is explicitly stopped or the worker exits.

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
  "storyType": "MINIMAX",
  "rendererConfig": {
    "model": "fal-max-ref2v",
    "continuity": "camera-anchors",
    "concurrency": 4,
    "maxBufferedSeconds": 45
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
| `fal-max-ref2v` | Kernel-supplied scene images when available, or images in `shotPlanner` / `initialImageUrl`; choose `camera-anchors` or `none`. |

Explicit fal models require `FAL_KEY` and never switch providers after a failure. Unsupported
model/strategy combinations fail before story provisioning. Turbo cannot use voice references;
no ElevenLabs mixing or lip-sync correction is added. Max can use the beat's raw 2–15-second
DSS audio URL, with an optional voice sample as fallback. Reference conditioning does not guarantee
an exact voice or performance.

`shotPlanner` also accepts named `characters`, `sets`, `styleImageUrl`, `styleDescription`,
`markNames`, and `initialImageUrl`. Character entries may contain `name`, `aliases`, `description`,
`imageUrl`, and `voice: { "url": "https://example.com/voice.mp3", "durationSeconds": 4 }`.
DSS supplies dialogue and staging; it does not necessarily supply character portraits or set images.
Use `storyType: "MINIMAX"` for a MiniMax EVD; explicit `CREATOR` and `WHISPERS` handoffs remain
supported. The story type selects the Kernel story format, independently of the video model.
Max validates image availability when a visual DSS shot is compiled, before submitting its video
job. This lets Kernel supply references in the stream instead of requiring a duplicate manual list.
If that Kernel does not supply images, the private handoff must provide them. Turbo still requires
an approved opening frame before start; an empty-set reference alone does not compose that frame.
The compiler carries blocking, strips spoken TTS tags into acting directions, and anchors style to
a set/style image. Ordinary `talking` animations preserve camera anchors; movement invalidates them.

The concurrency ceiling defaults to 4 (range 1–16). Last-frame dependencies serialize Turbo
regardless of that ceiling. `maxBufferedSeconds` defaults to 45 (range 5–150) and counts all reserved,
unplayed work, including pending and generating clips. Eight eight-second jobs need at least 64
seconds of budget. One oversized shot may occupy an otherwise empty budget to make progress.
This setting is not a startup buffer or permission to submit a batch.

Explicit fal modes can generate future received DSS while earlier clips play. Camera anchors
persist across chunks of the same scene, including repeated setup commands. A changed scene index
resets staging and continuity even when the set is reused. Media and completion acknowledgements remain in story order. The kernel
must supply enough lookahead. Playback begins with one ready clip to support short and ACK-gated
stories. Offline overlap does not prove sustained live realtime performance or visual quality.

`FAL_REQUEST_TIMEOUT_MS` (default 300000) caps one fal job from submit to completion. Under
account-level queueing a clip can wait several minutes, and a timeout fences the whole run, so
raise it when measuring rather than letting one slow job end a story. Each clip's run-status
record carries `falQueueSeconds` and `falMaxQueuePosition` so queueing on fal's side is visible.

Environment onboarding supports `STORY_RENDERER_CONFIG_JSON`, `STORY_SHOT_PLANNER_JSON`, and
`STORY_INITIAL_IMAGE_URL` for the same options. Existing handoffs with top-level `renderMode`,
`generationConcurrency`, and `maxBufferedSeconds` remain accepted; explicit `rendererConfig`
fields take precedence. Stop the active run before changing its settings.

## Replay recorded DSS offline

`npm run replay` feeds a recorded DSS stream through the same compiler, scheduler, and continuity
policy the live bridge uses, without a kernel connection. Recordings can be a JSON array, JSONL, or
`{received_at, event}` capture rows. Planning is free; `--render` submits the same paid fal jobs the
bridge would and assembles the clips into `story.mp4`.

```sh
npm run replay -- --dss recordings/story.jsonl --continuity camera-anchors --shot-planner refs.json
npm run replay -- --dss recordings/story.jsonl --from 40 --to 52 --model fal-turbo-i2v --initial-image https://... --render
```

Payloads before `--from` still replay staging, so a later range keeps its set and blocking, but
anchor and chain sources are chosen only inside the range. The summary lists each shot's dependency
(`anchor: establish`, `anchor: reuse <shot>`, `chain: from <shot>`) and, after rendering, provider
time against video time. `plan.json` / `run.json` land in `--out` (default `.renderer/replay/<time>`).
Replay skips kernel transport, playback pacing, and acknowledgements, so it measures generation
throughput and compilation, not sustained live playout.

## Hackathon rendering limits

Dialogue and supported character actions become generated video. Set and cast setup becomes prompt
context. Titles, credits, cutscenes, fades and supported engine controls are timing approximations;
they do not reproduce Unreal overlays or separate audio tracks. Unknown commands fail explicitly.
Stop cancels local generation/playout; the CLI separately stops the kernel story and records any
cleanup that must be retried.

New Minimax DSS payloads can additionally carry certified `scene_context`. The bridge validates
the authored set identity, each character's stable ID and exact DSS command name, the complete
participating cast, and an exact position for every cast member before submitting any video work.
It binds name-based talk commands to portraits through that certified identity, downloads the
supplied HTTPS images once per stable asset ID, selects the references needed by each shot, and
keeps the successful cached image when a later payload refreshes only its signed URL.
The full cast remains available as scene state; close-ups select only the visible character's
portrait. Prompt image labels follow the actual selected references, including optional style
images. Turbo carries the staging prose without citing reference images it cannot receive.
Certified positions describe a fixed scene layout; conflicting movement or cast removal fails
explicitly. Ordinary DSS without certified positions retains its existing movement behavior.

The inspected Kernel stream at `d4894200` does not emit `scene_context`. It normally sends one
command group per payload, including separate setup and dialogue chunks, and limits lookahead by
outstanding playback duration. The renderer compiles each group in order, carries state between
chunks, and acknowledges each original group only after its content or control delay has played.
It does not wait for a complete scene or acknowledge early to request more DSS.
