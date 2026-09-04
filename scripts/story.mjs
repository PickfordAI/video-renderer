import { watchUrlForStream } from './watch-url.mjs';
import { validateHandoff } from './handoff.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { api, hosted, option, readState, rendererOrigin, services, sessionFile, stateDir, writePrivate } from './config.mjs';
try {
  const action = process.argv[2] || 'start';
  const saved = readState(sessionFile);
  if (action === 'status') {
    if (!saved) throw new Error('No saved story.');
    console.log(JSON.stringify(await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'GET'), null, 2));
  } else {
    const handoffPath = option('handoff');
    if (!handoffPath) throw new Error('Pass --handoff /absolute/path/to/handoff.json. Credentials must never be command-line arguments.');
    let handoff;
    try { handoff = JSON.parse(readFileSync(handoffPath, 'utf8')); } catch { throw new Error('Cannot read handoff JSON. Check its path and syntax.'); }
    if (action === 'start') validateHandoff(handoff, hosted);
    const endpoints = { ...(hosted ? {} : services()), ...handoff.services };
    if (hosted && ['narrativeEngineUrl', 'rendererBaseUrl'].some(key => !endpoints[key]?.startsWith('https://'))) throw new Error('Hosted rendering requires HTTPS Story Kernel services from the onboarding handoff. Local Docker URLs are not reachable from a hosted renderer.');
    if (action === 'stop') {
      if (!saved) throw new Error('No saved story.');
      if (saved.runId) await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'DELETE');
      await api('/api/narrative/stop-show', { baseUrl: endpoints.narrativeEngineUrl, shortlink: saved.roomShortlink, token: handoff.setupToken });
      console.log(JSON.stringify({ stopped: true }));
    } else if (action === 'start') {
      if (!handoff.rendererId || !handoff.credentialId || !handoff.clientSecret || !handoff.evdId) throw new Error('Handoff requires rendererId, credentialId, clientSecret, and evdId. See docs/agents.md.');
      if (!handoff.story && !handoff.setupToken) throw new Error('Handoff requires setupToken to provision a story, or an existing story object.');
      if (!endpoints.narrativeEngineUrl || !endpoints.rendererBaseUrl) throw new Error('Run npm run setup or supply services in the handoff.');
      const health = await api('/api/health', undefined, 'GET');
      if (!health.falKeyConfigured) throw new Error('Configure FAL_KEY in the worker environment before starting a story.');
      if (saved?.runId) {
        const previous = await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'GET').catch(() => null);
        if (previous && ['connecting', 'running'].includes(previous.state)) throw new Error('A story is already running. Use npm run story -- status or stop it first.');
      }
      const story = handoff.story ?? await api('/api/narrative/provision-external-story', {
        baseUrl: endpoints.narrativeEngineUrl, token: handoff.setupToken, evdId: handoff.evdId,
        roomName: handoff.roomName || 'My story', storyType: handoff.storyType || 'CREATOR',
      });
      // Save provisioned identities before starting so failed starts can still be stopped.
      writePrivate(resolve(stateDir, sessionFile), story);
      let run = await api('/api/external-renderer/runs', {
        ...story, baseUrl: endpoints.rendererBaseUrl,
        rendererId: handoff.rendererId, credentialId: handoff.credentialId, clientSecret: handoff.clientSecret,
        environment: handoff.environment,
        rendererVersion: handoff.rendererVersion || 'h3.opensource.v1.0',
        resolution: handoff.resolution || '480P', clipDurationSeconds: handoff.clipDurationSeconds || 6,
        storyConfig: {
          base_structure: handoff.storyType || 'CREATOR', needs_plan_generation: false,
          use_existing_stream: true, generate_audio: true, text_only: false, audio_only: false,
          ...handoff.storyConfig, evd_id: handoff.evdId, message_channel_ids: [story.storyMessageChannelId],
        },
      });
      writePrivate(resolve(stateDir, sessionFile), { ...story, runId: run.runId });
      for (let attempt = 0; !run.hlsUrl && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        run = await api(`/api/external-renderer/runs/${run.runId}`, undefined, 'GET');
        if (run.state === 'failed') throw new Error('Renderer startup failed. Use npm run story -- status for diagnostics.');
      }
      if (!run.hlsUrl) throw new Error('Renderer did not initialize playout. Check story status.');
      const watchUrl = watchUrlForStream(run.hlsUrl);
      writePrivate(resolve(stateDir, sessionFile), { ...story, runId: run.runId, hlsUrl: run.hlsUrl, watchUrl });
      console.log(JSON.stringify({ runId: run.runId, state: run.state, hlsUrl: run.hlsUrl, watchUrl, next: 'npm run story -- status' }, null, 2));
    } else throw new Error('Use start, status, or stop.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
