import { resolve } from 'node:path';
import { dockerServices, option, servicePorts, stateDir, writePrivate } from './config.mjs';
import { configureHandoff, loadHandoff, onboardingStatus } from './onboarding.mjs';
try {
  const path = option('handoff');
  if (path) configureHandoff(path);
  const handoff = loadHandoff(path);
  const overrides = { ...process.env };
  // An explicit handoff supplies hosted URLs without needing Docker discovery.
  if (handoff.services?.narrativeEngineUrl) overrides.NARRATIVE_ENGINE_URL = handoff.services.narrativeEngineUrl;
  if (handoff.services?.rendererBaseUrl) overrides.RENDERER_PLATFORM_URL = handoff.services.rendererBaseUrl;
  const explicit = Object.fromEntries(Object.entries(servicePorts).filter(([, [env]]) => overrides[env]).map(([key, [env]]) => [key, overrides[env]]));
  const discovered = explicit.narrativeEngineUrl && explicit.rendererBaseUrl ? explicit : dockerServices(option('project'), overrides);
  const services = { ...discovered, ...handoff.services };
  const missing = ['narrativeEngineUrl', 'rendererBaseUrl'].filter(key => !services[key]);
  if (missing.length) throw new Error(`Could not discover ${missing.join(', ')}. Start the Story Kernel Docker stack or set NARRATIVE_ENGINE_URL and RENDERER_PLATFORM_URL for a hosted kernel.`);
  writePrivate(resolve(stateDir, 'services.json'), services);
  console.log(JSON.stringify({ ok: true, onboarding: onboardingStatus(), next: 'npm run doctor, then npm run story -- start. Open the local app; it follows the story automatically.' }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
