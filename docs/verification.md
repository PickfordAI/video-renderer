# Verification — StoryKernel generation integration, 2026-09-05

The generation branch incorporates Cole's single-player revision `47f00743` and keeps renderer
model/continuity configuration in agent-managed handoffs or environment variables.

- A clean `npm ci` followed by `npm run check` passed: **182 tests across 30 files**, TypeScript,
  and server/player production builds. The initial sandbox run could not bind localhost fixture
  servers (`listen EPERM`); the unchanged suite passed with local networking permitted. The retired
  studio tests are removed with the studio, so this count is not comparable to its earlier 227.
- `docker compose config --quiet` and `git diff --check` passed.
- A separate no-cost harness replayed captured Story12 DSS through the actual compiler, scheduler,
  fal adapters, FFmpeg and MediaMTX. Both Turbo i2v and Max ref2vid played three synthetic five-second
  clips. Their HLS master, variant and video segment returned 200, and playback reached the final
  clip before its Group_Finished. Each run wrote ten matching verdict acknowledgements, with zero
  pending or refused verdicts. Stop ended work and did not submit another job.
- Max's first two independent camera setups submitted concurrently; the returning setup reused its
  extracted anchor. Turbo submitted each successor after the predecessor's result/frame extraction.
  The harness used local fake fal queues, dummy credentials, and explicit outbound rejection.
  Executed source hashes were unchanged across the final pair. No paid provider calls occurred.
- A separate live local probe used the existing renderer credential: login 200, matching WebSocket
  welcome with no assignment, then clean disconnect. The local source was `329e1fe`, older than
  the edge contract inspected at `8ca50d8`; no new live story, manifest or provider call was made.
- An independent source review checked exact verdict correlation and ACK writes, natural completion
  after accepted playback, immediate Stop, and the pending-verdict age/count limits. Targeted
  regressions also cover in-place talking animations and visible-character identity references.

Not established: a fresh live StoryKernel episode through credits on the current backend, paid fal
latency or visual/voice fidelity, sustained realtime playback, hosted deployment, or automatic
reference-image delivery from Kernel. Canonical images still come from the private handoff.
The no-cost harness uses captured DSS, synthetic video and simulated verdicts; it is not deployed
Kernel acceptance. Temporary test services were stopped after evidence capture.

---

# Verification — single-player consolidation, 2026-09-04

Completed locally:

- Clean `npm ci` on Node 22.22.2; npm reported zero vulnerabilities.
- 79 tests passed across 19 test files, followed by server type checking and production builds.
  The count is lower than the earlier 135-test preparation because the retired React studio and
  its browser adapters/tests were removed. New tests cover registered handoffs, environment-file
  and direct-environment start/stop, readiness redaction, configuration failures, and viewer states.
- The build now produces one player. React, the second application build, and manual credential
  forms are removed. The remaining hls.js bundle produces Vite's size warning, not a build failure.
- The local operator root and public root returned identical player HTML with no input/form/select
  fields. The local legacy `/external-run.html` URL redirected to `/`. Retired source/config paths
  returned 404. Public `/api/viewer-status` and agent configuration paths returned 404.
- Local readiness returned only missing account categories and story playback state; actual local
  kernel services remained discovered. No real handoff or fal key is configured in this checkout.
- Browser checks confirmed the local page shows account readiness without setup forms. An isolated
  status fixture then moved the same player from ready to a running story without reloading or
  entering a URL. The player reached **Now playing** with a real synthetic HLS stream. A stopped
  status cleared the video and returned to the agent-managed status view.
- Local and VM Compose configuration checks and the hosted Docker image build passed. The hosted
  image ran as the non-root user with Render's `RENDER=true` / `PORT=4174` convention. Private
  readiness required the operator token, and public readiness was unavailable.
- The hosted image generated a six-second synthetic test clip with FFmpeg, normalized and
  published it through MediaMTX, and served it through the public HLS gateway. After playout stop,
  HLS returned 404. The temporary container, fixture server, and test browser tab were closed.
- The source archive was rebuilt and inspected to include the single player/configuration modules
  and deployment recipes, excluding old UI code, Git history, dependencies, build output and local
  credentials/state. Removed historical assets remain in old Git history.

Not established: an actual cloud deployment, external-device HTTPS playback, or paid fal rendering
against Story Kernel. The UI lifecycle fixture simulates run status; media playback uses real
FFmpeg/MediaMTX. No live kernel story was started and no audience messages were sent.

Earlier kernel protocol review used PR #6681 at `6f0689648228c46f6880349f9e0c888e3076c77c`.
