// Pure view mapping for the creator panel. No DOM, no fetch, so it is unit-tested directly.

export function environmentLabel(name) {
  return name === 'prod' ? 'Pickford' : `Pickford (${name})`;
}

export function signedInLabel(auth) {
  if (!auth?.signedIn) return 'Not signed in';
  return auth.email ? `Signed in as ${auth.email}` : 'Signed in to Pickford';
}

export function falKeyLabel(falKey) {
  // Only ever "present" or "missing". The key itself never reaches this page.
  return falKey?.present ? 'Key present' : 'Key missing';
}

export function rendererLabel(credential) {
  if (!credential?.present) return 'Not connected yet';
  if (credential.fenced) return 'Reconnecting needed';
  return credential.installationName ? `Connected as ${credential.installationName}` : 'Connected';
}

const PLAYBACK_LABELS = {
  idle: 'No StoryBundle playing',
  starting: 'Starting your StoryBundle…',
  preparing: 'Preparing your first scene',
  playing: 'Playing',
  ended: 'This StoryBundle finished',
  stopped: 'Stopped',
  failed: 'This StoryBundle stopped unexpectedly',
};

export function playbackLabel(playback) {
  const base = PLAYBACK_LABELS[playback?.state] ?? PLAYBACK_LABELS.idle;
  const eta = playback?.firstClipEtaSeconds;
  if (!['starting', 'preparing'].includes(playback?.state) || typeof eta !== 'number') return base;
  if (eta <= 0) return `${base} — any moment now`;
  const minutes = Math.ceil(eta / 60);
  return `${base} — first clip in about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}`;
}

/** What the Play control does for one bundle. `disabled` covers preparing and blocked bundles. */
export function bundleAction(bundle, status) {
  if (bundle.state === 'blocked') {
    return { disabled: true, label: 'Unavailable', detail: bundle.reason ?? 'Pickford cannot play this StoryBundle.' };
  }
  if (bundle.state === 'preparing') {
    return { disabled: true, label: 'Preparing images…', detail: bundle.reason ?? 'Preparing images…' };
  }
  if (!status?.falKey?.present) {
    return { disabled: true, label: 'Play', detail: 'Add your fal key above to play this StoryBundle.' };
  }
  if (['starting', 'preparing', 'playing'].includes(status?.playback?.state)) {
    return { disabled: true, label: 'Play', detail: 'Another StoryBundle is playing.' };
  }
  return { disabled: false, label: 'Play', detail: bundle.premiseLine ?? '' };
}

export function bundleTitle(bundle) {
  return typeof bundle.episodeNumber === 'number' && bundle.episodeNumber > 0
    ? `${bundle.title} · Episode ${bundle.episodeNumber}`
    : bundle.title;
}

/** Bundles are re-listed while any of them is still generating images. */
export function shouldAutoRefresh(bundles) {
  return Array.isArray(bundles) && bundles.some(bundle => bundle.state === 'preparing');
}

/** The one-line headline above the player while the creator panel owns this page. */
export function homeStatusMessage(status) {
  if (!status?.auth?.signedIn) return 'Sign in with Pickford to see your StoryBundles.';
  if (!status.falKey?.present) return 'Add your fal key below, then pick a StoryBundle.';
  if (status.playback?.state && status.playback.state !== 'idle') return playbackLabel(status.playback);
  return 'Pick a StoryBundle below and press Play.';
}

export function runIdentityLines(playback) {
  const lines = [];
  if (playback?.storyRunId) lines.push(`Story run ${playback.storyRunId}`);
  if (typeof playback?.storyId === 'number') lines.push(`Story ${playback.storyId}`);
  if (playback?.audienceJoinUrl) lines.push(`Audience link ${playback.audienceJoinUrl}`);
  return lines;
}
