import {
  bundleAction,
  bundleTitle,
  environmentLabel,
  falKeyLabel,
  playbackLabel,
  rendererLabel,
  runIdentityLines,
  shouldAutoRefresh,
  signedInLabel,
} from './creator-state.js';

// Sign in with Pickford, enter the fal key, pick a StoryBundle, press Play. Everything private
// (tokens, client secret, fal key) stays in the worker; this page only ever sees status.

const panel = document.querySelector('#creator');
const environment = document.querySelector('#creator-environment');
const account = document.querySelector('#creator-account');
const rendererState = document.querySelector('#creator-renderer');
const playbackState = document.querySelector('#creator-playback');
const identity = document.querySelector('#creator-identity');
const signIn = document.querySelector('#creator-sign-in');
const signOut = document.querySelector('#creator-sign-out');
const notice = document.querySelector('#creator-notice');
const falForm = document.querySelector('#fal-form');
const falInput = document.querySelector('#fal-key');
const falState = document.querySelector('#fal-state');
const bundleSection = document.querySelector('#bundles');
const bundleList = document.querySelector('#bundle-list');
const bundleStatus = document.querySelector('#bundle-status');

let csrfToken;
let status;
let bundles = [];
let statusTimer;
let bundleTimer;
let disposed = false;

function setText(node, value) {
  if (node) node.textContent = value;
}

async function call(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Pickford could not complete that request.');
  return value;
}

function renderStatus() {
  if (!status) return;
  panel.hidden = false;
  setText(environment, environmentLabel(status.environment));
  setText(account, signedInLabel(status.auth));
  setText(rendererState, rendererLabel(status.credential));
  setText(playbackState, playbackLabel(status.playback));
  setText(falState, falKeyLabel(status.falKey));
  document.querySelector('#setup').hidden = true;
  signIn.hidden = Boolean(status.auth?.signedIn);
  signOut.hidden = !status.auth?.signedIn;
  bundleSection.hidden = !status.auth?.signedIn;
  // A sign-in problem the creator has to act on (a missing role) outranks a bundle-list caveat.
  if (status.authNotice) setText(notice, status.authNotice);
  identity.replaceChildren(...runIdentityLines(status.playback).map(line => {
    const item = document.createElement('li');
    item.textContent = line;
    return item;
  }));
  renderBundles();
}

function renderBundles() {
  if (!bundles.length) {
    bundleList.replaceChildren();
    return;
  }
  bundleList.replaceChildren(...bundles.map(bundle => {
    const action = bundleAction(bundle, status);
    const card = document.createElement('li');
    card.className = `bundle bundle-${bundle.state}`;
    const heading = document.createElement('h3');
    heading.textContent = bundleTitle(bundle);
    const detail = document.createElement('p');
    detail.textContent = action.detail || bundle.premiseLine || '';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = action.label;
    play.disabled = action.disabled;
    play.addEventListener('click', () => void startBundle(bundle, play));
    card.append(heading, detail, play);
    return card;
  }));
}

async function startBundle(bundle, button) {
  button.disabled = true;
  setText(bundleStatus, `Starting ${bundle.title}…`);
  try {
    const run = await call('/api/creator/play', { method: 'POST', body: JSON.stringify({ evdId: bundle.evdId }) });
    setText(bundleStatus, run.storyRunId ? `Started. Story run ${run.storyRunId}.` : 'Started.');
    await refreshStatus();
  } catch (error) {
    setText(bundleStatus, error.message);
    button.disabled = false;
  }
}

async function refreshBundles() {
  clearTimeout(bundleTimer);
  if (!status?.auth?.signedIn) return;
  try {
    const value = await call('/api/creator/story-bundles');
    bundles = Array.isArray(value.bundles) ? value.bundles : [];
    setText(bundleStatus, bundles.length ? '' : 'No StoryBundles yet. Create one with StoryKernel, then refresh.');
    setText(notice, value.notice ?? '');
    renderBundles();
  } catch (error) {
    setText(bundleStatus, error.message);
  }
  // Bundles still generating images become playable on their own; keep the list honest.
  if (!disposed && shouldAutoRefresh(bundles)) bundleTimer = setTimeout(refreshBundles, 15_000);
}

async function refreshStatus() {
  clearTimeout(statusTimer);
  try {
    const value = await call('/api/creator/status');
    const wasSignedIn = status?.auth?.signedIn;
    csrfToken = value.csrfToken ?? csrfToken;
    status = value;
    renderStatus();
    if (value.auth?.signedIn && !wasSignedIn) await refreshBundles();
  } catch {
    // The worker restarts during development; the next poll picks the page back up.
  }
  if (!disposed) statusTimer = setTimeout(refreshStatus, 3000);
}

signIn?.addEventListener('click', async () => {
  signIn.disabled = true;
  setText(bundleStatus, '');
  try {
    const value = await call('/api/creator/sign-in', { method: 'POST', body: '{}' });
    setText(notice, 'Finish signing in with Pickford in the tab that just opened.');
    window.open(value.authorizationUrl, '_blank', 'noopener');
  } catch (error) {
    setText(notice, error.message);
  } finally {
    signIn.disabled = false;
  }
});

signOut?.addEventListener('click', async () => {
  signOut.disabled = true;
  try {
    status = await call('/api/creator/sign-out', { method: 'POST', body: '{}' });
    csrfToken = status.csrfToken ?? csrfToken;
    bundles = [];
    setText(notice, 'Signed out of Pickford on this machine.');
    renderStatus();
  } catch (error) {
    setText(notice, error.message);
  } finally {
    signOut.disabled = false;
  }
});

falForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = falInput.value;
  falInput.value = '';
  try {
    const value = await call('/api/creator/fal-key', { method: 'POST', body: JSON.stringify({ key }) });
    status = { ...status, falKey: value.falKey };
    setText(notice, 'Your fal key is stored on this machine only.');
    renderStatus();
  } catch (error) {
    setText(notice, error.message);
  }
});

window.addEventListener('pagehide', () => {
  disposed = true;
  clearTimeout(statusTimer);
  clearTimeout(bundleTimer);
});

export function startCreatorPanel() {
  if (!panel) return;
  void refreshStatus();
}

/** True once the local creator surface answered, which retires the legacy agent-setup checklist. */
export function creatorPanelVisible() {
  return Boolean(panel) && !panel.hidden;
}

export function creatorStatusSnapshot() {
  return status ?? null;
}
