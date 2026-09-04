import { resolve } from 'node:path';
import { dockerServices, option, stateDir, writePrivate } from './config.mjs';
try {
  const services = dockerServices(option('project'));
  const missing = ['narrativeEngineUrl', 'rendererBaseUrl'].filter(key => !services[key]);
  if (missing.length) throw new Error(`Could not discover ${missing.join(', ')}. Start the Story Kernel Docker stack or set NARRATIVE_ENGINE_URL and RENDERER_PLATFORM_URL for a hosted kernel.`);
  writePrivate(resolve(stateDir, 'services.json'), services);
  console.log(JSON.stringify({ ok: true, services, next: 'npm run doctor' }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
