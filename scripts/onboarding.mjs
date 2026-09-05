import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readState, services, stateDir, writePrivate } from './config.mjs';
import { validateHandoff } from './handoff.mjs';

// A handoff is one identity bundle. Never mix credentials from a file and the environment.
export function loadHandoff(path, env = process.env) {
  const selected = path || env.STORY_HANDOFF_PATH;
  const saved = selected || env.STORY_EVD_ID ? undefined : readState('onboarding.json')?.handoffPath;
  if (selected || saved) {
    try { return JSON.parse(readFileSync(resolve(selected || saved), 'utf8')); }
    catch { throw new Error('Cannot read the configured handoff. Have the agent check its path and JSON syntax.'); }
  }
  const value = {
    evdId: env.STORY_EVD_ID, setupToken: env.STORY_SETUP_TOKEN,
    rendererId: env.STORY_RENDERER_ID, credentialId: env.STORY_CREDENTIAL_ID,
    clientSecret: env.STORY_CLIENT_SECRET, environment: env.STORY_ENVIRONMENT,
    storyType: env.STORY_TYPE, roomName: env.STORY_ROOM_NAME,
    resolution: env.STORY_RESOLUTION, rendererVersion: env.STORY_RENDERER_VERSION,
    ...(env.STORY_CLIP_SECONDS ? { clipDurationSeconds: Number(env.STORY_CLIP_SECONDS) } : {}),
  };
  try {
    if (env.STORY_CONFIG_JSON) value.storyConfig = JSON.parse(env.STORY_CONFIG_JSON);
    if (env.STORY_JSON) value.story = JSON.parse(env.STORY_JSON);
  } catch { throw new Error('Agent-managed story JSON is invalid.'); }
  return value;
}

export function configureHandoff(path) {
  const handoff = validateHandoff(loadHandoff(path));
  if (!handoff.setupToken) throw new Error('Provide a setup token so the agent can stop the kernel story.');
  writePrivate(resolve(stateDir, 'onboarding.json'), { handoffPath: resolve(path) });
}

export function onboardingStatus(env = process.env) {
  const missing = [];
  if (!env.FAL_KEY && !env.FAL_API_KEY) missing.push('videoAccount');
  let handoff;
  try {
    handoff = validateHandoff(loadHandoff(undefined, env));
    if (!handoff.setupToken) missing.push('storyAccess');
  } catch { missing.push('storyAccess'); }
  try {
    const endpoints = { ...services(), ...handoff?.services };
    if (!endpoints.narrativeEngineUrl || !endpoints.rendererBaseUrl) missing.push('storyConnection');
  } catch { missing.push('storyConnection'); }
  return { ready: missing.length === 0, missing };
}
