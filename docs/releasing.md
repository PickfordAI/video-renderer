# Release checklist

This repository prepares source and deployment artifacts; it does not make a GitHub repository
public, provision cloud accounts, publish containers, or rotate existing credentials automatically.

## Source release

`npm run release:source` creates a clean, allowlisted `.tar.gz` under `.renderer/releases`,
without Git history, node_modules, build outputs, or local state. Review it before uploading.
This is a source snapshot, not a container release or a rewrite of existing Git history.

- Run `npm ci`, `npm run check`, `npm audit`, and `docker compose config --quiet` on Node 22+.
- Build and boot the hosted Docker target. Verify public `/healthz`, blocked operator routes,
  and a synthetic local HLS clip without calling fal.
- Run a real acceptance story against the intended kernel version: first frame, ordered speech,
  completion acknowledgements, stop, and a second viewer outside the host network. Also test
  the combined viewer/media origin and the chosen provider’s private operator connection. Mocks do not establish cloud acceptance.
- Review repository ownership and the MIT copyright holder; obtain permission for contributions
  made under any preexisting terms. Keep dependency notices with distributed artifacts.
- Scan the **full Git history**, branches, tags, and artifacts for secrets and private media before
  changing repository visibility. The original development history includes removed show assets;
  deleting them from the working tree does not remove history. Publish a clean source snapshot if
  that history is not intended for release; do not rewrite shared history without coordination.
- Ensure `.env`, `.renderer`, `.vercel`, actual handoffs, generated clips, and logs are excluded.
  The sample handoff contains dummy values only.
- Enable GitHub secret scanning, push protection, private vulnerability reporting, and branch
  protection requiring CI. These are repository settings, not source files.
- Set the release version and tag; publish the tested commit with known limitations and the
  compatible kernel version. `private: true` prevents accidental npm publishing; it does not
  prevent the repository from being open source.

## Container release

The `hosted` image includes MediaMTX and Alpine FFmpeg. Capture the exact resolved base image,
MediaMTX image digest, APK package versions, source references, and required notices for the
binary release. Do not rely on a moving `node:22-alpine` tag to identify the released image.
Archive/distribute matching GPL source/build material when required. Review the container scan
and publish an immutable digest. Source-release CI does not publish a container automatically.

## Current operational limits

Sessions are in memory; restarts/deploys interrupt playback. One active agent run per worker,
no durable resume, recording, or per-viewer authentication. The watch-link audience chat uses a
browser-local pseudonym and the renderer's fenced backend connection. The agent bridge
uses text prompts. The old reference-editing studio is removed; the single player has no manual
rendering or credential setup controls. Verify provider pricing before budgeting real runs.
