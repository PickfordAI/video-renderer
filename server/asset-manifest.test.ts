import { describe, expect, it } from 'vitest';

import { assetManifestFor, assetManifestSha256 } from './external-renderer.js';
import { parseRendererConfig } from './render-mode.js';

const VERSION = 'h3.opensource.v1.1';

function manifest(rendererConfig: Record<string, unknown>, providerKind: 'fal' | 'minimax-direct' = 'fal') {
  const parsed = parseRendererConfig(rendererConfig);
  return assetManifestFor({ rendererVersion: VERSION, renderMode: parsed.model, rendererConfig: parsed }, providerKind, {});
}

describe('renderer asset manifest identity', () => {
  it('registers one manifest for a version regardless of scheduler tuning', () => {
    // The creator Play route sends only the model and normalizes to concurrency 4 / 45 s; the documented
    // CLI example buffers 2 / 30 s. Both must hash identically or the second run on the same renderer
    // is refused with 4400 under the shared default version.
    const creator = manifest({ model: 'fal-max-ref2v' });
    const cli = manifest({ model: 'fal-max-ref2v', continuity: 'camera-anchors', concurrency: 2, maxBufferedSeconds: 30 });
    expect(assetManifestSha256(cli)).toBe(assetManifestSha256(creator));
    expect(creator.renderer_config).toEqual({ model: 'fal-max-ref2v', continuity: 'camera-anchors' });
    expect(creator.model).toBe('minimax/h3-max/reference-to-video');
  });

  it('changes the manifest when the generated assets change', () => {
    const base = assetManifestSha256(manifest({ model: 'fal-max-ref2v' }));
    expect(assetManifestSha256(manifest({ model: 'fal-max-ref2v', continuity: 'none' }))).not.toBe(base);
    expect(assetManifestSha256(manifest({ model: 'fal-turbo-i2v' }))).not.toBe(base);
    expect(assetManifestSha256(manifest({ model: 'auto' }, 'minimax-direct'))).not.toBe(assetManifestSha256(manifest({ model: 'auto' })));
    const fal = { rendererVersion: VERSION, renderMode: 'auto' as const, rendererConfig: parseRendererConfig({ model: 'auto' }) };
    expect(assetManifestSha256(assetManifestFor(fal, 'fal', { FAL_VIDEO_MODEL_ID: 'minimax/other' })))
      .not.toBe(assetManifestSha256(assetManifestFor(fal, 'fal', {})));
  });

  it('pins the version and output contract inside the manifest', () => {
    expect(manifest({ model: 'fal-max-ref2v' })).toMatchObject({
      renderer_version: VERSION,
      provider: 'fal',
      render_mode: 'fal-max-ref2v',
      output: { owner: 'external_renderer', protocol: 'hls' },
    });
  });
});
