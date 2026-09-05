# Deploy worker and viewer together

Choose one hosting provider. The `hosted` Docker image contains the renderer worker, FFmpeg,
MediaMTX, and the built viewer. A single HTTPS origin serves the player at `/`, its assets, and
live video under `/hls/`. There is no separate viewer deployment or hosting account to configure.

The Story Kernel and fal remain external dependencies from earlier onboarding. Hosted rendering
requires reachable HTTPS kernel services and a valid handoff. This guide deploys the renderer;
it does not provision the kernel itself.

| Option | Included setup | Agent handles |
|---|---|---|
| **Fly.io — default** | Deployment script and `fly.toml`; one always-on Machine | Fly login, app creation, secret import, private proxy |
| **Render** | `render.yaml`; one paid Docker web service, no static-site service | Blueprint deployment, secret injection, Render SSH access |
| **AWS EC2 / GCP Compute Engine / another Docker VM** | `deploy/compose.vm.yml` plus Caddy for HTTPS | VM creation/access, Docker, provider DNS, firewall, SSH |

Fly and Render assign HTTPS hostnames. A VM uses a domain in the user's existing DNS account;
the agent configures its DNS record using the provider's deployment output. If no domain is
available, choose Fly or Render to avoid adding a domain/DNS setup step. These are deployment
recipes, not automatically provisioned cloud resources. Confirm account/billing access before
creating resources. Use one replica per deployment; live sessions are not shared across replicas.

## Fly.io

With the Fly CLI authenticated and FAL_KEY already supplied through the environment or `.env`:

```sh
fly apps create <app-name>
npm run deploy:fly -- --app <app-name>
npm run hosted:connect
```

The deploy command imports secrets via stdin, stores the random operator token in private
`.renderer/hosted.json`, and deploys worker and viewer together. `deploy:worker` remains an alias
for compatibility. The shared public URL is derived from `FLY_APP_NAME`; no IP lookup is needed.
`fly.toml` exposes port 4174, enables HTTPS, disables autostop, and requests one Machine with two
shared CPUs and 2 GB RAM. The operator on 4173 is reachable only through the authenticated private
Fly connection, and still requires the operator token.

Keep `hosted:connect` running in a managed terminal while issuing story commands below. It uses
`fly proxy` with a loopback-only local binding. Closing the connection does not stop rendering.

## Render

Use the checked-in Blueprint as **one paid Docker web service**. It has one instance, automatic
deploys disabled, and a 2 CPU / 4 GB plan for FFmpeg. Do not substitute a sleeping free service.

First prepare credentials, using the same logical name for subsequent commands:

```sh
npm run hosted:prepare -- --provider render --name my-renderer
```

The agent deploys `render.yaml` through the user's authenticated Render account and fills its
`FAL_KEY` and `RENDERER_ADMIN_TOKEN` secret fields from `.renderer/hosting-secrets.json` without
printing them. Render assigns the URL; the worker derives its public URLs from `RENDER_EXTERNAL_URL`.
The launcher maps Render's `PORT` to the public listener while keeping operator port 4173 on
loopback. The image runs as the `node` user with the SSH directory required by Render.

Add the user's existing public SSH key to their Render account if needed. Retrieve this service's
actual SSH destination and HTTPS origin from Render, then record them:

```sh
npm run hosted:prepare -- --provider render --name my-renderer --origin https://actual-service.onrender.com --ssh actual-service-id@ssh.actual-region.render.com
npm run hosted:connect
```

Reusing the provider/name preserves the operator token. `hosted:connect` opens an SSH tunnel to
loopback port 4173 inside the running service, not an ephemeral shell instance. The same story
commands below now work with Render. Follow Render's host-key verification instructions.

## AWS, GCP, or another Docker VM

Use a dedicated always-on Linux VM with Docker Engine and Compose v2. Start with at least 2 CPUs
and 4 GB RAM and monitor the workload. Provision it using the user's existing AWS/GCP account;
select its provider-assigned identity via the cloud CLI rather than asking the user for an IP.
The agent manages SSH access and DNS in the same provider account where possible.

1. Provision/reuse the VM. Restrict SSH access to the operator; expose HTTP 80 and HTTPS 443 for
   Caddy. Never expose 4173, 4174, 8554, or relay administration ports in the cloud firewall.
2. Point a hostname in the user's existing DNS zone to the VM using the provider's returned
   address. Wait for DNS propagation. Remove stale AAAA records if the VM has no IPv6 listener.
3. Prepare the deployment locally. Use a verified SSH host/alias from the agent's SSH config:

```sh
npm run hosted:prepare -- --provider vm --name my-renderer --origin https://stories.example.com --ssh renderer-vm
```

4. Transfer the clean source snapshot and `.renderer/hosting.env` to the VM over authenticated
   SSH, retaining `0600` for the env file. These files stay private. Do not upload a handoff as
   part of a Docker build context. From the source directory **on the VM**, run:

```sh
docker compose --env-file .renderer/hosting.env -f deploy/compose.vm.yml up -d --build
```

Compose starts the single renderer container and Caddy on the **same VM**. Caddy obtains/renews
HTTPS certificates automatically and forwards only to the public viewer/media listener. The
operator is published on the VM's loopback interface. Certificate state persists in Docker
volumes. The agent's prepared origin becomes PUBLIC_APP_URL; all watch links use that hostname.

5. On the agent's computer, `npm run hosted:connect` opens the SSH tunnel. For environments using
   GCP IAP or AWS Session Manager instead of normal SSH, establish the equivalent authenticated
   local tunnel from 127.0.0.1:4175 to VM loopback 4173 through that provider's tooling. The story
   CLI works unchanged once the tunnel exists. VM creation, DNS and cloud-specific tunnel setup
   are agent-managed steps; the Compose template does not create that infrastructure.

## Start, share, and stop — same commands for every provider

With the private connection running and the agent's `STORY_HANDOFF_PATH`, registered handoff, or
STORY_* environment bundle configured locally (see [agents.md](agents.md)):

```sh
npm run story -- start --hosted
npm run story -- status --hosted
npm run share -- --hosted
```

`start` returns `watchUrl` directly. `share` recreates it from the saved session without asking for
a viewer URL. Both use the same origin as HLS, so no second deployment is involved. Credentials
never enter that URL. Anyone with the link can watch while the session is running.

The selected deployment is saved in `.renderer/hosted.json`; session metadata is in
`.renderer/hosted-session.json`. There is one selected hosted deployment per checkout. Stop the
previous story before switching providers. Do not run two active replicas: restarts/deployments
interrupt sessions, and durable resume is not implemented.

Verify the actual viewer loads from `/`, then that its manifest, playlist and segments are playable.
Public `/api/*`, `/external-run.html`, and agent configuration files must return 404. `/healthz` reports process
reachability; it does not verify kernel credentials or fal access. Test playback from an external
device after deployment. Use the play button to enable sound.

```sh
npm run story -- stop --hosted
```

The stopped stream returns 404. Close the private connection. Compute is still billed while the
host is idle; stop or remove unused infrastructure when authorized. Removing a host is separate
from stopping a story.

## Optional separate viewer

Existing Vercel users can still deploy `viewer-dist` with `vercel.json` and explicitly supply
`npm run share -- --hosted --viewer https://actual-viewer.vercel.app`. This is an advanced opt-in,
not part of the default onboarding flow. No Vercel persistent-worker recipe is included.

References: [Fly configuration](https://fly.io/docs/reference/configuration/),
[Fly proxy](https://fly.io/docs/flyctl/proxy/), [Render web services](https://render.com/docs/web-services),
[Blueprint fields](https://render.com/docs/blueprint-spec), [Render SSH](https://render.com/docs/ssh),
[Render port forwarding](https://render.com/docs/deploy-temporal),
[Render environment](https://render.com/docs/environment-variables),
[Caddy HTTPS](https://caddyserver.com/docs/automatic-https).
