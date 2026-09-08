import { watchUrlForStream } from './watch-url.mjs';
import { renderingOptions, validateHandoff } from './handoff.mjs';
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
    const identity = { startMode: saved.startMode ?? 'legacy', storyRunId: saved.storyRunId ?? null, audienceJoinUrl: saved.audienceJoinUrl ?? null, storyId: saved.storyId ?? null };
    console.log(JSON.stringify(run ? { ...identity, ...run } : { ...identity, state: saved.kernelStopped ? 'stopped' : 'cleanup_required', next: 'Use npm run story -- stop before starting another story.' }, null, 2));
  } else {
    const handoffPath = option('handoff');
    const handoff = loadHandoff(handoffPath);
    if (action === 'start') validateHandoff(handoff, hosted);
    const opaque = (action === 'stop' ? saved?.startMode ?? handoff.startMode : handoff.startMode) === 'opaque';
    if (!opaque && !handoff.setupToken) throw new Error('Configure the setup token through the agent handoff or environment so the kernel story can be stopped.');
    const endpoints = { ...services(), ...handoff.services };
    if (hosted && ['narrativeEngineUrl', 'rendererBaseUrl'].some(key => endpoints[key] !== undefined && !endpoints[key]?.startsWith('https://'))) throw new Error('Hosted rendering requires HTTPS Story Kernel services from the onboarding handoff. Local Docker URLs are not reachable from a hosted renderer.');
    if (action === 'stop') {
      if (!saved) throw new Error('No saved story.');
      const failures = [];
      let retainedMedia = null;
      if (!saved.workerStopped) {
        try {
          if (saved.runId) {
            const run = await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'DELETE');
            if (opaque) Object.assign(saved, { storyRunId: run.storyRunId ?? saved.storyRunId, audienceJoinUrl: run.audienceJoinUrl ?? saved.audienceJoinUrl, storyId: run.storyId ?? saved.storyId });
            if (run.mediaDir) retainedMedia = { mediaDir: run.mediaDir, finalMp4: run.finalMp4 ?? null };
          }
          saved.workerStopped = true;
        } catch (error) {
          if (error.status === 404) saved.workerStopped = true; // Worker restart cleared the run.
          else failures.push('worker');
        }
        writePrivate(resolve(stateDir, sessionFile), saved);
      }
      if (!saved.kernelStopped) {
        const kernelBaseUrl = saved.showBaseUrl || endpoints.narrativeEngineUrl;
        if (opaque && !(saved.storyId && handoff.setupToken && kernelBaseUrl)) {
          // The kernel exposes no renderer-side cancel for opaque runs; never claim one happened.
          saved.kernelCancelUnavailable = !saved.storyId ? 'story id was never resolved' : !handoff.setupToken ? 'no setupToken in the handoff' : 'no narrativeEngineUrl';
          writePrivate(resolve(stateDir, sessionFile), saved);
          if (failures.length) throw new Error(`Cleanup incomplete (${failures.join(', ')}). Restore worker/private connection, then retry stop. Saved recovery state has been retained.`);
          console.log(JSON.stringify({ stopped: true, kernelStopped: false, ...retainedMedia, kernelCancel: `not possible: ${saved.kernelCancelUnavailable}. The Story Kernel owns this run; end it from the kernel if it is still active.` }, null, 2));
          process.exit(0);
        }
        try {
          await api('/api/narrative/stop-show', opaque
            ? { baseUrl: kernelBaseUrl, storyId: saved.storyId, token: handoff.setupToken }
            : { baseUrl: kernelBaseUrl, shortlink: saved.roomShortlink, token: handoff.setupToken });
          saved.kernelStopped = true;
          delete saved.kernelCancelUnavailable;
          delete saved.hlsUrl;
          delete saved.watchUrl;
        } catch { failures.push('kernel'); }
        writePrivate(resolve(stateDir, sessionFile), saved);
      }
      if (failures.length) throw new Error(`Cleanup incomplete (${failures.join(', ')}). Restore worker/private connection or refresh kernel login, then retry stop. Saved recovery state has been retained.`);
      console.log(JSON.stringify({ stopped: true, ...retainedMedia }));
    } else if (action === 'start') {
      if (!handoff.rendererId || !handoff.credentialId || !handoff.clientSecret || !handoff.evdId) throw new Error('Handoff requires rendererId, credentialId, clientSecret, and evdId. See docs/agents.md.');
      if (!opaque && !handoff.story && !handoff.setupToken) throw new Error('Handoff requires setupToken to provision a story, or an existing story object.');
      if (!endpoints.rendererBaseUrl || (!opaque && !endpoints.narrativeEngineUrl)) throw new Error('Run npm run setup or supply services in the handoff.');
      validateHandoff({ ...handoff, services: endpoints }, hosted);
      const health = await api('/api/health', undefined, 'GET');
      const renderOptions = renderingOptions(handoff);
      if (renderOptions.rendererConfig.model !== 'auto' && !health.falKeyConfigured) throw new Error('The selected rendering mode requires FAL_KEY in the worker environment.');
      if (!health.falKeyConfigured && !health.minimaxKeyConfigured) throw new Error('Configure MINIMAX_API_KEY or FAL_KEY in the worker environment before starting a story.');
      if (saved?.runId) {
        const previous = await api(`/api/external-renderer/runs/${saved.runId}`, undefined, 'GET').catch(error => {
          if (error.status === 404) return null;
          throw error;
        });
        if (previous && ['connecting', 'running'].includes(previous.state)) throw new Error('A story is already running. Use npm run story -- status or stop it first.');
      }
      // An opaque run whose kernel cancel was impossible stays kernel-owned; only worker cleanup blocks a new start.
      if (saved && (!saved.workerStopped || (!saved.kernelStopped && !saved.kernelCancelUnavailable))) throw new Error('The previous story still needs cleanup. Run npm run story -- stop before starting another story.');
      const identity = {
        rendererId: handoff.rendererId, credentialId: handoff.credentialId, clientSecret: handoff.clientSecret,
        environment: handoff.environment,
        // An explicit bridge URL beats the platform's advertised one, which a local stack
        // publishes as its self-signed TLS port rather than its plain WebSocket port.
        ...(endpoints.rendererWebsocketUrl ? { websocketUrl: endpoints.rendererWebsocketUrl } : {}),
        rendererVersion: handoff.rendererVersion || 'h3.opensource.v1.2',
        resolution: handoff.resolution || '480P', clipDurationSeconds: handoff.clipDurationSeconds || 6,
      };
      let recovery;
      let run;
      if (opaque) {
        recovery = { startMode: 'opaque', evdId: handoff.evdId, showBaseUrl: endpoints.narrativeEngineUrl, workerStopped: false, kernelStopped: false };
        writePrivate(resolve(stateDir, sessionFile), recovery);
        const exchangeBase = endpoints.audienceExchangeUrl ?? (endpoints.chatBackendUrl ? `${endpoints.chatBackendUrl}/api/v1/external-audience/exchange` : undefined);
        run = await api('/api/external-renderer/runs', {
          ...renderOptions, ...identity, baseUrl: endpoints.rendererBaseUrl,
          startMode: 'opaque', evdId: handoff.evdId, ...(exchangeBase ? { audienceExchangeUrl: exchangeBase } : {}),
        });
      } else {
        const story = handoff.story ?? await api('/api/narrative/provision-external-story', {
          baseUrl: endpoints.narrativeEngineUrl, token: handoff.setupToken, evdId: handoff.evdId,
          roomName: handoff.roomName || 'My story', storyType: handoff.storyType || 'CREATOR',
        });
        // Save provisioned identities before starting so failed starts can still be stopped.
        recovery = { ...story, showBaseUrl: endpoints.narrativeEngineUrl, workerStopped: false, kernelStopped: false };
        writePrivate(resolve(stateDir, sessionFile), recovery);
        run = await api('/api/external-renderer/runs', {
          ...story, ...renderOptions, ...identity, baseUrl: endpoints.rendererBaseUrl,
          storyConfig: {
            needs_plan_generation: false,
            use_existing_stream: true, generate_audio: true, text_only: false, audio_only: false,
            ...handoff.storyConfig, base_structure: handoff.storyType ?? 'CREATOR', evd_id: handoff.evdId, message_channel_ids: [story.storyMessageChannelId],
          },
        });
      }
      writePrivate(resolve(stateDir, sessionFile), { ...recovery, runId: run.runId });
      for (let attempt = 0; !run.hlsUrl && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        run = await api(`/api/external-renderer/runs/${run.runId}`, undefined, 'GET');
        if (run.state === 'failed') throw new Error('Renderer startup failed. Use npm run story -- status for diagnostics.');
      }
      if (!run.hlsUrl) throw new Error('Renderer did not initialize playout. Check story status.');
      const watchUrl = watchUrlForStream(run.hlsUrl);
      if (['failed', 'stopped'].includes(run.state)) throw new Error('Renderer startup failed. Inspect status and stop the story before retrying.');
      const identityFromRun = opaque ? { storyRunId: run.storyRunId ?? null, audienceJoinUrl: run.audienceJoinUrl ?? null, storyId: run.storyId ?? null } : {};
      writePrivate(resolve(stateDir, sessionFile), { ...recovery, ...identityFromRun, runId: run.runId, hlsUrl: run.hlsUrl, watchUrl });
      console.log(JSON.stringify({ runId: run.runId, state: run.state, startMode: opaque ? 'opaque' : 'legacy', ...identityFromRun, hlsUrl: run.hlsUrl, watchUrl, next: 'npm run story -- status' }, null, 2));
    } else throw new Error('Use start, status, or stop.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
