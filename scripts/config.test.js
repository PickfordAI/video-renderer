import { describe, expect, it } from 'vitest';
import { discoverServices } from './config.mjs';
const container = (project, service, ports) => ({ Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service } }, NetworkSettings: { Ports: Object.fromEntries(Object.entries(ports).map(([inner, outer]) => [`${inner}/tcp`, [{ HostIp: '0.0.0.0', HostPort: String(outer) }]])) } });
describe('Docker service discovery', () => {
  const stack = [container('story', 'renderer-platform', { 8080: 8293 }), container('story', 'unified', { 8081: 8281, 8091: 8291, 8092: 8292, 8080: 8280 })];
  it('uses published ports without inspecting container IPs', () => {
    expect(discoverServices(stack)).toMatchObject({ rendererBaseUrl: 'http://127.0.0.1:8293', narrativeEngineUrl: 'http://127.0.0.1:8281', chatBackendUrl: 'http://127.0.0.1:8280' });
  });
  it('does not silently choose between stacks', () => {
    const multiple = [...stack, container('other', 'renderer-platform', { 8080: 9993 })];
    expect(() => discoverServices(multiple)).toThrow('Multiple');
    expect(discoverServices(multiple, 'other').rendererBaseUrl).toBe('http://127.0.0.1:9993');
  });
  it('supports hosted services without Docker', () => {
    expect(discoverServices([], undefined, { RENDERER_PLATFORM_URL: 'https://renderer.example' })).toEqual({ rendererBaseUrl: 'https://renderer.example' });
  });
});
