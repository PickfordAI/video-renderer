import { rendererOrigin } from './config.mjs';

// `npm run auth -- status|login|logout`. The browser does the actual sign-in; this is the CLI face
// of the same local endpoints, so an agent can check state and sign the creator out without one.

const action = process.argv[2] || 'status';

async function call(path, options = {}) {
  const response = await fetch(`${rendererOrigin}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      // The creator surface only answers the same-origin local page; this CLI is that origin.
      Origin: rendererOrigin,
      'Sec-Fetch-Site': 'same-origin',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `${path} failed (HTTP ${response.status}).`);
  return value;
}

try {
  const status = await call('/api/creator/status');
  const csrf = { 'X-CSRF-Token': status.csrfToken };
  if (action === 'status') {
    console.log(JSON.stringify({
      environment: status.environment,
      auth: status.auth,
      credential: status.credential,
      falKey: status.falKey,
      playback: status.playback,
    }, null, 2));
  } else if (action === 'login') {
    const { authorizationUrl } = await call('/api/creator/sign-in', { method: 'POST', headers: csrf, body: '{}' });
    console.log(JSON.stringify({
      next: 'Open this URL in a browser and approve the connection, then re-run npm run auth -- status.',
      authorizationUrl,
    }, null, 2));
  } else if (action === 'logout') {
    await call('/api/creator/sign-out', { method: 'POST', headers: csrf, body: '{}' });
    console.log(JSON.stringify({ signedOut: true }, null, 2));
  } else {
    throw new Error('Use status, login, or logout.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
