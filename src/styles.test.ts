import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

describe('video stage layout', () => {
  it('contains generated-video intrinsic sizing inside a stable stage', () => {
    const stageColumn = declarationsFor('.stage-column, .side-column');
    const stageChildren = declarationsFor('.stage-column > *');
    const stage = declarationsFor('.stage');
    const video = declarationsFor('.stage > video');
    const activeVideo = declarationsFor('.stage > video.active');
    const streamStartButton = declarationsFor('.empty-stage .stream-start-button');
    const audioControl = declarationsFor('.master-audio-control');
    const startGate = declarationsFor('.show-start-gate');
    const startDialog = declarationsFor('.show-start-dialog');
    const clipRail = declarationsFor('.clip-rail');
    const clipList = declarationsFor('.clip-list');

    expect(stageColumn).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(stageChildren).toContain('max-width: 100%');
    expect(stage).toContain('aspect-ratio: 16 / 9');
    expect(stage).toContain('contain: layout size paint');
    expect(stage).toContain('overflow: hidden');
    expect(video).toContain('position: absolute');
    expect(video).toContain('inset: 0');
    expect(video).toContain('max-width: 100%');
    expect(video).toContain('max-height: 100%');
    expect(video).toContain('opacity: 0');
    expect(activeVideo).toContain('opacity: 1');
    expect(streamStartButton).toContain('z-index: 1');
    expect(streamStartButton).toContain('position: relative');
    expect(audioControl).toContain('pointer-events: auto');
    expect(startGate).toContain('position: fixed');
    expect(startGate).toContain('z-index: 100');
    expect(startDialog).toContain('width: min(480px, 100%)');
    expect(clipRail).toContain('overflow: hidden');
    expect(clipList).toContain('overflow-x: auto');
    expect(clipList).toContain('max-width: 100%');
  });
});
