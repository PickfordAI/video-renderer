import { watchUrlForStream } from './watch-url.mjs';
import { validateHandoff } from './handoff.mjs';
import { loadHandoff } from './onboarding.mjs';
import { resolve } from 'node:path';
import { api, hosted, option, readState, services, sessionFile, stateDir, writePrivate } from './config.mjs';
try {
  const action = process.argv[2] || 'start';
  const saved = readState(sessionFile);
  if (action === 'status') {
    if (!saved) throw new Error('No saved story.');
    const run = saved.runId ? await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'GET').catch(error => {
      if (error.status === 404) return null;
      throw error;
    }) : null;
    console.log(JSON.stringify(run ?? { state: saved.kernelStopped ? 'stopped' : 'cleanup_required', next: 'Use npm run story -- stop before starting another story.' }, null, 2));
  } else {
    const handoffPath = option('handoff');
    const handoff = loadHandoff(handoffPath);
    if (action === 'start') validateHandoff(handoff, hosted);
    if (!handoff.setupToken) throw new Error('Configure the setup token through the agent handoff or environment so the kernel story can be stopped.');
    const endpoints = { ...services(), ...handoff.services };
    if (hosted && ['narrativeEngineUrl', 'rendererBaseUrl'].some(key => !endpoints[key]?.startsWith('https://'))) throw new Error('Hosted rendering requires HTTPS Story Kernel services from the onboarding handoff. Local Docker URLs are not reachable from a hosted renderer.');
    if (action === 'stop') {
      if (!saved) throw new Error('No saved story.');
      const failures = [];
      if (!saved.workerStopped) {
        try {
          if (saved.runId) await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'DELETE');
          saved.workerStopped = true;
        } catch (error) {
          if (error.status === 404) saved.workerStopped = true; // Worker restart cleared the run.
          else failures.push('worker');
        }
        writePrivate(resolve(stateDir, sessionFile), saved);
      }
      if (!saved.kernelStopped) {
        try {
          await api('/api/narrative/stop-show', { baseUrl: saved.showBaseUrl || endpoints.narrativeEngineUrl, shortlink: saved.roomShortlink, token: handoff.setupToken });
          saved.kernelStopped = true;
          delete saved.hlsUrl;
          delete saved.watchUrl;
        } catch { failures.push('kernel'); }
        writePrivate(resolve(stateDir, sessionFile), saved);
      }
      if (failures.length) throw new Error(`Cleanup incomplete (${failures.join(', ')}). Restore worker/private connection or refresh kernel login, then retry stop. Saved recovery state has been retained.`);
      console.log(JSON.stringify({ stopped: true }));
    } else if (action === 'start') {
      if (!handoff.rendererId || !handoff.credentialId || !handoff.clientSecret || !handoff.evdId) throw new Error('Handoff requires rendererId, credentialId, clientSecret, and evdId. See docs/agents.md.');
      if (!handoff.story && !handoff.setupToken) throw new Error('Handoff requires setupToken to provision a story, or an existing story object.');
      if (!endpoints.narrativeEngineUrl || !endpoints.rendererBaseUrl) throw new Error('Run npm run setup or supply services in the handoff.');
      validateHandoff({ ...handoff, services: endpoints }, hosted);
      const health = await api('/api/health', undefined, 'GET');
      if (!health.falKeyConfigured) throw new Error('Configure FAL_KEY in the worker environment before starting a story.');
      if (saved?.runId) {
        const previous = await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'GET').catch(error => {
          if (error.status === 404) return null;
          throw error;
        });
        if (previous && ['connecting', 'running'].includes(previous.state)) throw new Error('A story is already running. Use npm run story -- status or stop it first.');
      }
      if (saved && (!saved.kernelStopped || !saved.workerStopped)) throw new Error('The previous story still needs cleanup. Run npm run story -- stop before starting another story.');
      const story = handoff.story ?? await api('/api/narrative/provision-external-story', {
        baseUrl: endpoints.narrativeEngineUrl, token: handoff.setupToken, evdId: handoff.evdId,
        roomName: handoff.roomName || 'My story', storyType: handoff.storyType || 'CREATOR',
      });
      // Save provisioned identities before starting so failed starts can still be stopped.
      const recovery = { ...story, showBaseUrl: endpoints.narrativeEngineUrl, workerStopped: false, kernelStopped: false };
      writePrivate(resolve(stateDir, sessionFile), recovery);
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
      writePrivate(resolve(stateDir, sessionFile), { ...recovery, runId: run.runId });
      for (let attempt = 0; !run.hlsUrl && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        run = await api(`/api/external-renderer/runs/${run.runId}`, undefined, 'GET');
        if (run.state === 'failed') throw new Error('Renderer startup failed. Use npm run story -- status for diagnostics.');
      }
      if (!run.hlsUrl) throw new Error('Renderer did not initialize playout. Check story status.');
      const watchUrl = watchUrlForStream(run.hlsUrl);
      if (['failed', 'stopped'].includes(run.state)) throw new Error('Renderer startup failed. Inspect status and stop the story before retrying.');
      writePrivate(resolve(stateDir, sessionFile), { ...recovery, runId: run.runId, hlsUrl: run.hlsUrl, watchUrl });
      console.log(JSON.stringify({ runId: run.runId, state: run.state, hlsUrl: run.hlsUrl, watchUrl, next: 'npm run story -- status' }, null, 2));
    } else throw new Error('Use start, status, or stop.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
