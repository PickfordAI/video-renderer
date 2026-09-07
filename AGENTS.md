# Working in this repository

Read README.md and docs/agents.md before onboarding or deployment work. The renderer is standalone;
the Story Kernel is an external service, not a local package dependency.

- Use Node 22+ and npm ci. Validate with npm run check and docker compose config --quiet.
- Preserve existing user changes. Do not start paid video generation or live story/audience actions
  merely to run tests. Tests use fixtures/mocks and require no keys.
- Treat .env, handoff JSON, and .renderer files as secrets. Never print credentials or include them
  in public artifacts, browser bundles, links, commits, logs, or build contexts.
- Keep the operator port private. The public port serves the built viewer, read-only HLS, and
  same-origin audience messages bound to its active renderer run.
  Deploy worker and viewer together by default. Vercel is an optional standalone viewer only.
- There is one frontend in viewer/. It carries exactly two inputs the creator owns: Sign in with
  Pickford, and their own fal key. Never add a service-URL, renderer-id, or client-secret form.
- Runtime credentials are either self-minted by the worker after the creator's OAuth sign-in, or
  supplied by the legacy kernel onboarding handoff. Do not scrape container secrets or call
  internal privileged credential APIs. See docs/agents.md for both supported flows.
- Never ask a user for their fal key, and never handle one on their behalf. They enter it on the
  local page; it stays in .renderer/, goes only to fal, and is never echoed back to the page.
- Keep docs/architecture.md honest about adapter differences and deployment/recovery limitations.
- Run relevant regressions for protocol, lifecycle, configuration, and access-boundary changes.
