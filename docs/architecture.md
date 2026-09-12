# Architecture and protocol

```text
Kernel onboarding -> private handoff -> agent CLI -> operator API (4173)
                                            |
Kernel Renderer Platform <-> renderer bridge + fal -> FFmpeg -> MediaMTX
                                                                 |
                              viewer + HLS + audience input (4174)
                                                                 |
                                                   browser (same origin)
```

## Runtime paths

`server/external-renderer.ts` implements renderer installation login, the authenticated query-free
bridge WebSocket, manifest registration, renderer-pinned story start, lease heartbeats, DSS
handling, and correlated command completion. It validates the separate story and room-main
channels. The setup user token is used by the provisioning/stop proxy only; renderer runtime
uses the installation credential. Login tier is derived from the kernel environment.

In opaque start mode the run never learns a story ahead of time. The start request carries only
`{evd_id, idempotency_key}`; the key embeds the renderer ID, EVD ID, and the run ID so a rerun of
the same EVD is a new story rather than a replay. The kernel answers 202 with `story_run_id`, a
shareable `audience_join_url`, and `status: audience_ready`. The run then POSTs the join URL's opaque
handle to the public audience exchange (`Origin` set to the join URL origin) and reads `story_id`
and `message_channel_id` from the returned session; that ID is used for the audience relay and
cross-checked against the DSS `episode_id`. Assignment fencing is unchanged: it keys on the
assignment ID and generation carried by every DSS frame, not on a pre-known story.

Opaque startup keeps its bridge and lease heartbeats alive while recovering start HTTP
408/502/503/504 responses or fetch transport failures. After an accepted start, audience-exchange
transport and 5xx failures retry with the same opaque handle. Retries are sequential, one second
apart, and both phases share one 180-second deadline (including in-flight requests). Start retries
reuse the identical body and idempotency key. Authentication/validation/conflict errors and all
audience-exchange 4xx responses remain terminal; legacy starts are not automatically retried. Stop or bridge
disconnection aborts pending startup and backoff. Once the deadline expires, status
reports that Kernel may still own the run; no new start identity is minted. This
recovers an ambiguous response within the existing process, not a process restart.

The configured-provider adapter compiles each DSS group serially. Explicit fal modes compile
ordered groups into immutable shot plans, carrying staging across payloads. Their shared scheduler
can generate later received DSS while earlier clips play. Group acknowledgements follow actual
playback; generation completion does not advance the kernel cursor. Supported nonvisual controls
use timing approximations. The adapter does not reproduce a 3D renderer's exact animation or overlays.
Transient fal status reads use a bounded retry budget. Once fal reports an already-paid request
`COMPLETED`, transient result reads continue within the original generation deadline; the renderer
never replays the paid submission.

Both video adapters send assignment-fenced `Script_Started` once per story block when the playout
timeline first reaches its video, including when polling observes that a short clip already finished.
Generation/enqueue alone never sends it. This drives Kernel's `PLAYING` state independently of
fast-acknowledged command progress; only `Group_Finished` advances completion.

The sole frontend is `viewer/`, served on both the local operator listener and public media
listener. The old React room/SSE studio and manual credential form are removed. Renderer runtime
uses the installation-credential bridge only. The remaining private generation/provisioning API
helpers are available for diagnostics; they are not a second user setup flow.

`scripts/onboarding.mjs` resolves a registered handoff path, STORY_HANDOFF_PATH, or the STORY_*
environment bundle for the CLI. `setup` persists only the file path and discovered service URLs.
The browser receives a fixed allowlist of readiness flags, story state, HLS URL, and an ephemeral
same-origin CSRF token. It never
receives the handoff, provider keys, setup token, renderer credentials, or backend diagnostics.
Start/stop stays with the agent; opening the player never starts paid generation.

Audience input travels from the viewer to a bounded same-origin endpoint on the renderer. The
server derives the story from its active run and sends the existing `audience.message` envelope
over the authenticated, fenced Renderer Platform WebSocket. The browser cannot choose a story,
channel, renderer, backend URL, or bearer token. Renderer Platform resolves the active audience
grant and persists accepted input through Chat. A random browser-local UUID provides a stable
external subject; it is a pseudonym, not authentication. Possession of the watch link permits
participation for the active story.

`server/playout.ts` downloads clips, normalizes H.264/AAC, publishes an RTSP timeline, and supplies
hold frames while generation catches up. Playback uses the full returned clip's measured duration.
A kernel-commanded pause (a timed control such as `fade`
or `delay`) travels with the next clip as `leadInSeconds` and is fed as hold frames on the timeline,
so clips keep normalizing ahead of playback; each clip boundary reports that lead-in separately from
stall holds, and only stall holds count as playback gaps. MediaMTX exposes fMP4 HLS internally.
FFmpeg progress and the configured audience delay estimate playback completion; acknowledgements
are not proof that every individual viewer has watched the clip.

`server/media.ts` only proxies HLS files belonging to a live in-memory playout session. The UUID
in a stream URL is a capability, not a user login. On stop/restart the gateway no longer serves
that session. This is live viewing, without archives, durable sessions, or guaranteed replay.

## Interfaces

Operator API (local only, or bearer-authenticated private Fly/SSH proxy):

| Route | Purpose |
|---|---|
| `GET /api/health` | Provider model names and whether a fal key is configured; never the key |
| `GET /api/viewer-status` | Sanitized setup readiness and current playback; private listener and explicitly loopback-bound local viewer only |
| `GET /api/audience-chat/session`, `POST /api/audience-chat/messages` | Same-origin audience chat for the active story, shared with the public listener |
| `POST /api/narrative/provision-external-story` | Create private room, inactive story, and resolve distinct channels |
| `POST /api/external-renderer/runs` | Start one bridge worker run; returns 202 while connecting. `startMode: opaque` starts from `evdId` alone |
| `GET /api/external-renderer/runs/:id` | Run progress/diagnostics |
| `DELETE /api/external-renderer/runs/:id` | Stop worker activity and playout; CLI separately stops the kernel story |
| `POST /api/narrative/stop-show` | Cancel kernel story and leave room using a valid user session; `storyId` instead of `shortlink` resolves the room for opaque runs |
| `/api/generate`, `/api/playout/*`, other `/api/narrative/*` | Private generation/protocol diagnostics |

Public listener: `GET`/`HEAD /` and allowlisted built viewer assets, `GET /healthz`,
`GET`/`HEAD /hls/h3-:session/:file`, `GET /api/audience-chat/session`, and
`POST /api/audience-chat/messages`. Audience writes require the exact configured viewer origin,
an ephemeral CSRF token, bounded JSON, and an active story/HLS run. Other routes/methods return
404 or 405. Static files are served only from dist/viewer; neither agent configuration nor server
source is accessible. Fly/Render derive the public origin from platform metadata; VMs use
PUBLIC_APP_URL set by the agent. When this listener is explicitly bound to loopback (the local
default), it additionally serves the allowlisted `GET /api/viewer-status` payload so `/` can follow
the active local story after real clip playout begins. Hosted listeners bind externally and retain
the capability-link-only root. Worker and viewer ship together on the chosen host.

### Creator surface (loopback local page only)

When the viewer listener is bound to loopback, it also serves the creator surface that lets the
signed-in creator drive the renderer without an agent. Every route requires a same-origin local
page (`Host`, `Sec-Fetch-Site: same-origin`, no forwarding headers); mutations additionally require
this process's ephemeral CSRF token. It is handled before the permissive media CORS header is
applied, so nothing here is readable cross-origin.

| Route | Purpose |
|---|---|
| `GET /api/creator/status` | Sign-in, renderer-credential, fal-key and playback status, plus the CSRF token. Never a token, secret, or key |
| `POST /api/creator/sign-in` | Discover Pickford's OAuth metadata, register dynamically if needed, return an authorization URL |
| `GET /auth/pickford/callback` | The loopback redirect. Authenticated by the PKCE `state`, since it is a cross-site top-level navigation by design |
| `POST /api/creator/sign-out` | Revoke the refresh token and clear `.renderer/auth.json` |
| `GET /api/creator/story-bundles` | The creator's StoryBundles with `ready`/`preparing`/`blocked` state |
| `POST /api/creator/play` | Mint or rotate the renderer credential if needed, then start a new opaque run and request fenced supersession of this renderer's prior Story Run |
| `POST /api/creator/stop` | Cancel the active Pickford story, then stop that exact local renderer run |
| `POST`/`DELETE /api/creator/fal-key` | Store or clear the creator's fal key in `.renderer/fal.json` (0600). Presence only is ever reported |

The worker is a public OAuth 2.1 client: RFC 9728 resource-metadata discovery, RFC 8414
authorization-server discovery, RFC 7591 dynamic registration with `token_endpoint_auth_method:
none`, authorization code + PKCE S256, RFC 8707 resource indicators, and refresh-token rotation.
Tokens live in `.renderer/auth.json` (0600).

The production resource is `https://api.pickford.ai/renderer` and the scope is
`storykernel:renderer`. Other environments supply their resource through private URL overrides.
Identity treats resource and scope as a fixed pair and answers `invalid_scope` for any other
combination, so `scopeForResource` derives one from the other and the dynamic-client cache is keyed
by scope as well as issuer and redirect URI — a changed pairing re-registers rather than reusing a
client that cannot authorize. Discovery rejects any metadata document that declares a resource
other than the one requested: an origin can serve several protected resources (Pickford's
bare-origin document describes the hosted MCP), and adopting the wrong one would bind the
renderer's tokens to the wrong audience. When a resource's metadata advertises exactly one scope and it is not
the derived one, the advertised value wins, so a renamed scope needs no renderer release.

Access tokens last 12 hours and the grant 90 days. Refresh tokens are single-use and rotating: a
replay revokes the grant. `PickfordAuth.accessToken` therefore serializes concurrent demands into a
single refresh, attempts it exactly once per stored token, and on rejection discards the stored
sign-in instead of retrying.

`POST /bff/v1/session` doubles as the whoami for a bearer client: it answers
`{user_id, role, csrf_token: null}` and sets no cookie. The account email is a separate best-effort
read from Identity's `/auth/get_user`; without it the page names the account by role.

Two adapters remain for each backend call, with the bearer path primary. Credential minting uses
`POST /bff/v1/developer/renderers` with the OAuth bearer; the `browser-session` adapter
(`POST /bff/v1/session` for a cookie + CSRF token, then replay) is dormant behind it for an older
BFF and is only reached on a 401 — a 403 is a role denial and is reported as one. Bundle listing
uses `GET /bff/v1/story-bundles` and falls back to `GET /show/published-evds?story_type=MINIMAX`
only on 404/405; that fallback carries no premise line and no owner field, and the page says so
when it cannot scope the list. Note that `/bff/v1/*` and `/api/v1/renderers/*` are served from the
frontend origin on deployed environments, while Identity and the hosted MCP are on the API origin;
`pickford-environment.ts` keeps those separate.

`POST /api/v1/renderers/start-story` answers 202 with `story_run_id`, `story_id`, `room_shortlink`,
`audience_join_url` and `status`. The story id and shortlink are adopted straight from that
response, and the audience exchange then only has to agree — a contradiction fails the run. An
unplayable bundle answers 409 `{"detail": {"code": "STORY_BUNDLE_NOT_READY", "state", "message"}}`,
and that message is surfaced to the creator rather than collapsed into a status code. Creator Play
also sends `supersede_existing: true`: the authenticated backend must quiesce and exact-fence only
this renderer's previous Story Run before admitting the request's fresh idempotency identity. A
replay of that same identity must recover the new run rather than cancel it.

Creator Stop posts to `/bff/v1/stories/{story_id}/cancel` on the frontend origin with the creator's
OAuth bearer and the exact story id returned by that start. The BFF derives the creator identity
from that bearer, and Show/Admin accepts already-inactive owned stories idempotently. Only after
Pickford accepts cancellation does the worker stop the same renderer run id, so a cancellation
failure remains retryable and a concurrent new run cannot be stopped accidentally.

## Compatibility and recovery

The streaming DSS and playback-credit contracts were inspected at StoryKernel commit
`d4894200eec9d462150923d7f4dd220d891c78ef`. The current certified start supplies the renderer,
story/room identity and stable start idempotency key; Kernel resolves the story configuration.
This is contract evidence, not proof of a complete
live story. The protocol is still evolving; verify login, start, assignment, DSS, media, verdicts
and Stop when upgrading. Offline fixtures do not establish provider or deployed-kernel acceptance.

Completion events carry deterministic `client_event_id` values, distinct for each logical group
and progress event. Authoritative verdicts are correlated to the renderer, stream, assignment lease,
generation and sequence before their exact verdict/event IDs are acknowledged. The private run
status records pending, acknowledged and refused verdicts. A transport rejection has no verdict ID
and is recorded as a failure without fabricating an acknowledgement.
Missing verdicts are bounded during active playback as well: at most 128 pending events and a
30-second pending-verdict deadline. The bridge stops on a missing return path before continuing
to submit further generation.

On natural completion, the bridge stops accepting new DSS, finishes already accepted generation
and playback, then waits up to five seconds for pending verdict acknowledgements to be written.
Missing verdicts are a reported failure, so an older kernel without verdict delivery cannot pass
this completion check. User Stop still cancels local work immediately; the CLI separately requests
kernel Stop and keeps recovery state if either cleanup step fails. Socket closure alone does not
prove that the kernel released its assignment.

There is one active agent run per worker. Run records, queues, and media are ephemeral. Automatic
resume after a process crash is not implemented. Creator Play asks the backend to supersede this
renderer installation's previous exact Story Run before starting a new one; CLI starts retain their
explicit stop/reconcile workflow. Retrying `start` is not a durable idempotency guarantee across a network failure.
The CLI saves provisioned identities before renderer start so ordinary failed starts can be
cleaned up. If provisioning itself fails partway, inspect/reconcile the created room through the
kernel onboarding flow before retrying. No automatic synthetic audience traffic is generated.


## Explicit fal continuity modes

`rendererConfig.model=auto` preserves the configured direct MiniMax/fal adapter. Explicit
`fal-turbo-i2v` and `fal-max-ref2v` require a fal credential even when a direct MiniMax key is
present; failures never switch providers. Run settings accept an HTTPS `initialImageUrl`,
`shotPlanner` reference/style settings, `rendererConfig.concurrency` (default 4, at most 16), and
`rendererConfig.maxBufferedSeconds` (default 45, at most 150).

New modes compile each accepted DSS frame in order into immutable shot/group plans before
submitting its video jobs. Turbo image-to-video requires an initial image and chains each scene's
next shot from the previous clip's last frame. Reference-to-video with camera-anchors uses configured character/set
references for the first shot of each camera/continuity setup, then adds that anchor clip's first
frame to later matching shots (the last frame instead when the anchor shot contains movement, preserving its resulting pose). Camera-anchors reserves one of the 12 total reference slots for continuity before any submissions. Independent camera setups can generate concurrently; dependent
shots wait for their anchor generation/frame extraction, not for playback. Failed anchors fail
their dependents instead of silently removing references.

The scheduler reserves unplayed video duration in playback order, including dependency waits,
so later jobs cannot starve an earlier dependent shot. One shot larger than the configured budget
may occupy an otherwise empty buffer. A single sequential compiler prepares later received DSS
payloads while an ordered consumer plays earlier ones. The scheduler, camera anchors, and chain
tails are shared across these payloads. Prepared payloads are bounded independently of video
duration, including payloads that contain only control commands. Enqueue and group completion stay in DSS order. Control
waits complete before their group acknowledgement; generation progress does not advance the
kernel's sequence high-water mark. Stop aborts provider and frame-extraction jobs and drains them.
A changed assignment terminates the run; it cannot enqueue stale results or silently resume.

Kernel normally streams one command group per payload; its wire contract also permits multiple
groups. Setup, camera and dialogue can therefore arrive separately. One planner consumes all
groups in order and carries cast, set and camera state. `scene_index` advances the scene identity
even when no `scene_context` is present or two scenes share the same set. Repeated preambles within
one scene do not themselves start a new scene. A payload's numeric sequence is not a command type;
setup is classified by its commands rather than silently dropping every sequence-zero payload.
Original payload sequences and group IDs are retained for completion events.

Kernel releases more contiguous DSS until the weighted duration of outstanding unplayed commands
reaches its target, then waits for playback cursor advancement. The renderer processes whatever
lookahead has arrived without requiring a scene-sized batch. `Group_Finished` advances that cursor;
the separate exact verdict ACK confirms receipt of the authoritative outcome. Neither compilation
nor provider completion is grounds for a playback acknowledgement.

A FIFO feeder sends each generated clip to media preparation as soon as preceding clips have been
enqueued. An independent playback consumer waits for the played position before releasing its
reservation or acknowledging its group. This permits normalization ahead of playback without
waiting for an entire group to generate, which could deadlock when that group exceeds the budget.
Positive-duration control transitions stop the feeder at the group boundary until preceding
playback and the declared delay complete; zero-duration boundaries do not prevent prefeeding.

Generation failure in a later prepared payload aborts the run without waiting for earlier
playback to finish. Stop and receiver failure wake the planning and playback consumers. Duplicate
payloads are ignored before compilation, so they cannot mutate staging twice or submit extra jobs.
The configured-provider (`auto`) adapter retains its serial behavior.

The video-duration budget counts work reserved for pending, in-flight, and ready-but-unplayed
shots. Longer-than-requested clips can temporarily exceed the budget through already-submitted work.
It is not a startup runway or a measure of contiguous playable footage. Playback starts
with one clip; requiring multiple clips can deadlock a short story or a kernel waiting for the
current completion acknowledgement. No synthetic progress or early GroupFinished events are sent
to obtain more lookahead. If the kernel has not delivered later DSS, the renderer cannot generate
it. Offline overlap and ordering tests do not prove sustained live throughput or voice/lip-sync
quality.

The explicit-mode prompt compiler separates bracketed TTS directions from spoken dialogue, binds
speech to its subject, and makes listener eye-lines relative to the camera in tight shots. It
distinguishes exact dialogue audio from a generic voice sample. Dedicated style and set images can
anchor visual style; character portraits remain identity references. Camera cuts hold established
blocking unless an action changes it, while Turbo's supplied frame retains its framing. Repeated
character declarations update carried state; they are not assumed to replace the complete cast.
The kernel's in-place performance animations (`talking`, `hands on hips`, `thinking`, and the other
known stationary gestures) retain the camera anchor. Position-changing and unknown animations still
invalidate anchors conservatively. A camera anchor is keyed by scene, framing, speaker and eyeline
partner, and the blocking of on-screen cast only, so an off-screen character changing marks does not
discard an established close-up frame.

The private operator `POST /api/video-frame` extracts first/last continuity frames. The public
viewer cannot call it. Extraction is restricted to the supported fal media CDN, with bounded
size/time and cancellation; resulting JPEG data stays internal to the rendering flow.
These additions have offline mocked validation until separately exercised with real providers.


### Model and continuity are separate choices

The canonical run `rendererConfig` contains `model`, `continuity`, `concurrency`, and
`maxBufferedSeconds`. Model chooses the provider endpoint; continuity chooses dependencies and
frame extraction. Supported combinations are auto/none, Turbo image-to-video/last-frame-chain,
and Max reference-to-video with either none or camera-anchors. Unsupported combinations fail
before generation. Legacy renderMode/concurrency fields normalize to their previous strategies.

Max with continuity none generates independent shots using configured references and performs no
frame extraction. It can use all 12 reference slots. Selecting camera-anchors for that same model
adds per-setup dependencies and reserves one slot for the extracted continuity frame. Both use the
same duration-budgeted scheduler and ordered playback acknowledgements. Concurrency is an explicit
limit within the selected strategy, not a synonym for the model or a promise that dependent shots
can run simultaneously.

### Reuse in another renderer

`DssShotPlanner` is the stateful DSS-to-prompt boundary: feed groups in order and retain its
immutable plans, reference bindings, and group IDs. `ShotGenerator` owns the continuity policy on
top of `ShotScheduler`: it decides whether a shot establishes or reuses a camera anchor or chains from
a scene tail, submits the provider call, and extracts the continuity frame. The live bridge and the
offline `npm run replay` harness share that one implementation. `ShotScheduler` bounds asynchronous
generation without knowing the transport or media player. Provider adapters select model endpoints
independently of that scheduling policy.

`external-renderer.ts` is the integration layer: it supplies assignment fencing, bounded payload
queues, camera/chain dependencies, ordered media enqueue, and playback acknowledgements. A host
with different transport or playout can reuse the compiler and scheduler while adapting that
layer. Preserve actual-playback budget release, timing barriers, and cancellation when porting;
generation completion alone is insufficient to acknowledge DSS.


### Canonical references and derived images

StoryKernel owns the canonical character and empty-set images. The renderer accepts the additive
certified `scene_context` contract, binds character IDs and exact command names, validates complete
positions, and caches successful image downloads by immutable asset ID across signed-URL refreshes.
The inspected deployed Kernel at `d4894200` does not yet emit that context; private handoff
`shotPlanner` images remain available for this path. Max checks its final per-shot references
before provider submission, so a Kernel-only reference stream does not need a duplicate manual
image list. Missing images fail explicitly. Turbo still needs an approved initial frame at start.

The compiler selects identity pictures for the shot's visible characters while retaining the full
certified cast and fixed positions for later shots. Tight shots omit the listener's portrait.
Legacy spawn marks cannot overwrite certified positions; conflicting explicit movement, posture
changes or cast removal require a new scene context instead of contradictory prompt instructions.
Reference citations are assigned from the final ordered picture list; initial-frame-only prompts
carry staging without inventing reference-array citations. Set and style references remain
separate from character identity. Derived camera anchors and last-frame continuity belong to the
renderer. A future Turbo opening-frame composition should use the relevant canonical set/cast and
be cached separately; it must not overwrite those source assets. Refreshable references or cross-run
caches would also need upstream asset versions in their cache keys. Automatic opening-frame
generation and changes to the Kernel wire format are outside this renderer integration.

### Prepared stationary coverage (PIC-1920)

The configured `fal-max-ref2v` adapter advertises typed `prepared_coverage_versions: [1]`
in `renderer.hello`. Other adapters omit it and reject prepared catalogs before generation.
Legacy `scene_context` remains supported. A v1 catalog supplies a full-cast master, one
speaker closeup per cast member, body orientations, immutable preparation/source identities,
and SHA-256 hashes for the compositions and full original portraits. It does not create a
second command, acknowledgement or playback lifecycle.

The renderer validates exact cast membership and distinct assets, then verifies downloaded
composition and original portrait bytes before a provider submission. Prepared images bypass
downscaling. Signed URL refresh retains cached bytes; a fresh run verifies them again. Catalog,
identity or position mutation within an accepted scene fails closed. A fixture of the wire
contract lives in `server/fixtures/prepared-coverage-dss.json`; its URLs and bytes are test data.

Prepared shots use the ensemble master unless DSS explicitly requests a speaker closeup.
Unsupported reaction closeups fail instead of selecting unrelated coverage. The composition
is reference Image 1; only the visible cast's full original portraits follow it, in the
composition's declared order. Portrait references bind character identity, never global
style or camera placement. Body orientation stays as prepared while authored `look` takes
precedence over respondent-derived gaze. Unknown or ambiguous respondents preserve the
composed eyeline; visible listeners watch the speaker unless they have an authored look.
Offscreen recipients remain outside the shot.

These shots enter the existing bounded scheduler independently and reference the prepared
composition directly; they never await or append a frame extracted from the first video.
A repeated master retains its setup identity across speaker changes. This provides stable
framing, not continuous performance across independent generated clips. Existing measured
full-clip duration, playout, `Script_Started` and `Group_Finished` handling still applies.
