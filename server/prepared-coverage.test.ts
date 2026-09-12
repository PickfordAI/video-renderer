import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDssFrame } from './external-renderer.js';
import { MinimaxSceneAssetCache, parseMinimaxSceneContext } from './scene-context.js';
import { DssShotPlanner } from './shot-planner.js';
import { ShotGenerator } from './shot-generation.js';
import type { ShotScheduler } from './shot-scheduler.js';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/prepared-coverage-dss.json', import.meta.url), 'utf8'));
const raw = () => fixture().script.scene_context;
const maya = '11111111-1111-4111-8111-111111111111';
const theo = '22222222-2222-4222-8222-222222222222';
const download = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(`downloaded:${new URL(url).pathname.split('/').at(-1)}`, { headers: { 'content-type': 'image/png' } })));
async function planner() {
  download();
  const p = new DssShotPlanner({ styleImageUrl: 'https://other.example/style.jpg', initialImageUrl: 'https://other.example/opening.jpg' });
  p.applySceneContext(await new MinimaxSceneAssetCache().resolve(parseMinimaxSceneContext(raw())), 0);
  return p;
}
const talk = (character: string, respondent?: string, camera_shot?: string) => ({ command: 'talk', args: { character, respondent, camera_shot, dialogue: 'We should stay here.' } });
afterEach(() => vi.unstubAllGlobals());

describe('prepared coverage v1', () => {
  it('compiles canonical DSS master and authored speaker closeup with exact reference roles', async () => {
    download();
    const frame = parseDssFrame(fixture());
    const p = new DssShotPlanner();
    p.applySceneContext(await new MinimaxSceneAssetCache().resolve(frame.sceneContext!), frame.sceneIndex);
    const master = p.planGroup(frame.groups[0].commands, 'master', 'block').shots[0];
    const closeup = p.planGroup(frame.groups[1].commands, 'closeup', 'block').shots[0];
    expect(master.imageReferences.map(r => r.name)).toEqual(['composition', 'Maya', 'Theo']);
    expect(closeup.imageReferences.map(r => r.name)).toEqual(['composition', 'Theo']);
    expect(closeup.prompt).toContain('Maya remains outside the shot');
    expect(closeup.prompt).toContain('Image 2 only as their full original character identity');
    expect(closeup.prompt).not.toContain('Image 2 for the overall rendering style');
    expect(closeup.referenceImageUrls[1]).toBe('data:image/png;base64,' + Buffer.from('downloaded:theo.png').toString('base64'));
  });
  it('reuses master setup independent of speaker/respondent and returns to master after closeup', async () => {
    const p = await planner();
    const a = p.planGroup([talk('Maya', 'Theo')], 'a', 'block').shots[0];
    p.planGroup([talk('Theo', 'Maya', 'Character_CloseUp')], 'b', 'block');
    const c = p.planGroup([talk('Theo', 'unknown')], 'c', 'block').shots[0];
    expect(c.setupKey).toBe(a.setupKey);
    expect(c.anchorKey).toBe(a.anchorKey);
    expect(c.imageReferences.map(r => r.name)).toEqual(['composition', 'Maya', 'Theo']);
    expect(c.prompt).toContain('no recipient is inferred');
    expect(c.prompt).not.toContain('unknown has');
  });
  it('preserves authored gaze independently of body orientation', async () => {
    const p = await planner();
    const shot = p.planGroup([talk('Maya', 'Theo'), { command: 'look', args: { character: 'Maya', target: { name: 'window' } } }, { command: 'look', args: { character: 'Theo', target: { name: 'door' } } }], 'a', 'block').shots[0];
    expect(shot.prompt).toContain('Maya follows the authored look toward window');
    expect(shot.prompt).toContain('Theo follows the authored look toward door');
    expect(shot.prompt).toContain('Seated torso facing the doorway');
    expect(shot.prompt).not.toContain('Maya speaks to Theo');
  });
  it.each(['version', 'missing-closeup', 'visible', 'hash', 'overlap'])('rejects malformed %s without fallback', field => {
    const value = raw();
    const c = value.prepared_coverage;
    if (field === 'version') c.version = 2;
    if (field === 'missing-closeup') delete c.closeups[maya];
    if (field === 'visible') c.master.visible_character_ids = [maya];
    if (field === 'hash') c.character_content_sha256[theo] = 'invalid';
    if (field === 'overlap') c.master.asset_id = value.character_images[0].asset_id;
    expect(() => parseMinimaxSceneContext(value)).toThrow();
  });
  it('rejects unverified catalog and unsupported initial-frame adapter', () => {
    const context = parseMinimaxSceneContext(raw());
    const p = new DssShotPlanner();
    p.applySceneContext(context);
    expect(() => p.planGroup([talk('Maya')], 'a', 'block')).toThrow('hash verification');
    expect(() => new DssShotPlanner({ referenceMode: 'initial-frame' }).applySceneContext(context)).toThrow('reference adapter');
  });
  it('rejects unavailable authored reaction closeup rather than choosing generic coverage', async () => {
    const p = await planner();
    expect(() => p.planGroup([{ command: 'character camera', args: { character: 'Theo', shot: 'Character_CloseUp' } }, talk('Maya')], 'a', 'block')).toThrow('coverage is unavailable');
  });
  it('rejects unprepared camera views and movement animations', async () => {
    const p = await planner();
    expect(() => p.planGroup([talk('Maya', 'Theo', 'Character_POV')], 'pov', 'block')).toThrow('coverage is unavailable');
    expect(() => p.planGroup([{ command: 'play animation', args: { character: 'Maya', animation: 'walk across room' } }], 'move', 'block')).toThrow('stationary coverage');
  });
  it('hashes original bytes and never downscales prepared portraits or compositions', async () => {
    download();
    const downscale = vi.fn(async (bytes: Uint8Array, contentType: string) => ({ bytes, contentType }));
    const uploader = vi.fn(async (_bytes: Uint8Array, _type: string, filename: string) => `https://fal.media/${filename}`);
    const cache = new MinimaxSceneAssetCache({ downscale, uploader });
    const context = await cache.resolve(parseMinimaxSceneContext(raw()));
    expect(context.preparedCoverage?.verified).toBe(true);
    expect(downscale).toHaveBeenCalledTimes(1); // Only the legacy empty set, never submitted for prepared shots.
    expect(uploader).toHaveBeenCalledTimes(6);
    const changed = raw();
    changed.prepared_coverage.master.content_sha256 = '0'.repeat(64);
    await expect(cache.resolve(parseMinimaxSceneContext(changed))).rejects.toThrow('immutable identity changed');
  });
  it.each(['portrait', 'composition'])('rejects %s digest mismatch before accepting references', async role => {
    download();
    const value = raw();
    if (role === 'portrait') value.prepared_coverage.character_content_sha256[maya] = '0'.repeat(64);
    else value.prepared_coverage.master.content_sha256 = '0'.repeat(64);
    await expect(new MinimaxSceneAssetCache().resolve(parseMinimaxSceneContext(value))).rejects.toThrow('content hash mismatch');
  });
  it('keeps immutable cached bytes across URL refresh and verifies again in a fresh run', async () => {
    download();
    const cache = new MinimaxSceneAssetCache();
    const first = await cache.resolve(parseMinimaxSceneContext(raw()));
    const value = raw();
    value.prepared_coverage.master.image_url += '?refreshed';
    const repeated = await cache.resolve(parseMinimaxSceneContext(value));
    expect(repeated.preparedCoverage?.master.imageUrl).toBe(first.preparedCoverage?.master.imageUrl);
    expect(fetch).toHaveBeenCalledTimes(6);
    await new MinimaxSceneAssetCache().resolve(parseMinimaxSceneContext(value));
    expect(fetch).toHaveBeenCalledTimes(12);
  });
  it('never waits for a video anchor and uses all 12 reference slots for prepared shots', async () => {
    const p = await planner();
    const shot = p.planGroup([talk('Maya')], 'a', 'block').shots[0];
    const generator = new ShotGenerator({ renderMode: 'fal-max-ref2v', continuity: 'camera-anchors', resolution: '480P', apiKey: 'unused', scheduler: {} as ShotScheduler<never>, signal: new AbortController().signal, independentStartupShots: 0 });
    expect(generator.plan(shot)).toEqual({ kind: 'independent' });
    expect(generator.plan(shot)).toEqual({ kind: 'independent' });
    expect(() => generator.validate({ ...shot, referenceImageUrls: Array(12).fill('https://fal.media/image.png') })).not.toThrow();
  });
});
