# Verification — 2026-09-04

Completed locally for the open-source preparation:

- Clean `npm ci` on Node 22.22.2; `npm audit`: zero reported vulnerabilities.
- 135 tests passed across 27 test files. Added coverage for Docker discovery, handoff validation,
  CLI start/stop without secret persistence, private operator/public media boundaries, and bridge
  lifecycle including cancellation, failure cleanup, acknowledgement, and no synthetic audience sends.
- Type checking and production studio, server, and standalone viewer builds passed. Vite reports
  large-bundle warnings for hls.js; these are not build failures.
- Local and VM Compose configuration validation and the hosted Docker image build passed.
- Combined-host coverage checks Fly/Render/VM watch URLs, platform URL discovery, private SSH/Fly
  connection commands, credential file permissions, and token reuse after recording a Render URL.
- Auto-discovery resolved the running PR #6681 Compose stack's published service ports. Its worktree
  HEAD is `6f0689648228c46f6880349f9e0c888e3076c77c`.
- A synthetic six-second clip was generated inside the hosted image with FFmpeg. The renderer
  downloaded/normalized it, published RTSP, and served an HLS master playlist, media playlist,
  and nonempty segment through the read-only gateway. The viewer served by the **same container
  and public port** reached **Now playing** in the browser, with the synthetic test pattern visible.
  This used the non-root hosted image with Render's `RENDER=true` and `PORT=4174` convention;
  the launcher correctly kept operator requests on 4173.
- Operator requests without the token returned 403; operator paths on the public media port returned
  404. Studio pages and source files on the public port returned 404. After stopping playout, the
  stream returned 404 while the viewer still loaded. The temporary container and browser were closed.
- The source archive was inspected for excluded Git history, local state, environment files,
  node_modules and generated build directories. A limited history pattern scan of three commits
  found no matching private keys, GitHub/AWS tokens, or literal fal key assignments. This is not
  a comprehensive secret-scanning guarantee. Removed media still exists in old Git history.

Not established by these checks: an actual Fly.io, Render, VM, or optional Vercel deployment; external-device HTTPS
playback, or a paid fal generation run against the real Story Kernel. Those acceptance checks
require authenticated deployment/provider accounts and a valid user/renderer handoff. No live
story was started and no audience messages were sent during these checks.
