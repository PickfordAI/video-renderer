import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
export const stateDir = resolve('.renderer');
export function writePrivate(path, value) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
export function readState(name) {
  const path = resolve(stateDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
export function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
export const servicePorts = {
  narrativeEngineUrl: ['NARRATIVE_ENGINE_URL', 'unified', 8081],
  narrativeAuthoringUrl: ['NARRATIVE_AUTHORING_URL', 'unified', 8091],
  realtimeGatewayUrl: ['REALTIME_GATEWAY_URL', 'unified', 8092],
  chatBackendUrl: ['CHAT_BACKEND_URL', 'unified', 8080],
  rendererBaseUrl: ['RENDERER_PLATFORM_URL', 'renderer-platform', 8080],
};
export function discoverServices(containers, project, overrides = {}) {
  const projects = [...new Set(containers.filter(c =>
    c.Config?.Labels?.['com.docker.compose.service'] === 'renderer-platform'
  ).map(c => c.Config.Labels['com.docker.compose.project']))];
  if (!project && projects.length > 1) throw new Error('Multiple Story Kernel stacks found. Pass --project with the Compose project name.');
  const selected = project ?? projects[0];
  const services = {};
  for (const [name, [env, service, port]] of Object.entries(servicePorts)) {
    if (overrides[env]) { services[name] = overrides[env]; continue; }
    const container = containers.find(c => c.Config?.Labels?.['com.docker.compose.project'] === selected
      && c.Config.Labels['com.docker.compose.service'] === service);
    const binding = container?.NetworkSettings?.Ports?.[`${port}/tcp`]?.find(p => p.HostIp !== '::');
    if (binding) services[name] = `http://127.0.0.1:${binding.HostPort}`;
  }
  return services;
}
export function dockerServices(project, overrides = process.env) {
  let containers = [];
  try {
    const ids = execFileSync('docker', ['ps', '-q'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).filter(Boolean);
    // Inspect only labels and published ports. Never collect container environment secrets.
    if (ids.length) containers = execFileSync('docker', ['inspect', '--format', '{"Config":{"Labels":{{json .Config.Labels}}},"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}}}', ...ids], { encoding: 'utf8' }).trim().split('\n').map(JSON.parse);
  } catch { /* Hosted services can be supplied entirely through environment variables. */ }
  return discoverServices(containers, project, overrides);
}
export function services() {
  const saved = readState('services.json') ?? {};
  for (const [name, [env]] of Object.entries(servicePorts)) if (process.env[env]) saved[name] = process.env[env];
  return saved;
}
export const hosted = process.argv.includes('--hosted');
const hostedState = hosted ? readState('hosted.json') : null;
export const sessionFile = hosted ? 'hosted-session.json' : 'session.json';
export const rendererOrigin = `http://127.0.0.1:${hosted ? 4175 : process.env.PORT || 4173}`;
const adminToken = process.env.RENDERER_ADMIN_TOKEN || hostedState?.adminToken;
export async function api(path, body, method = 'POST') {
  const response = await fetch(`${rendererOrigin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`${path} failed (HTTP ${response.status}). Check the worker diagnostics.`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
