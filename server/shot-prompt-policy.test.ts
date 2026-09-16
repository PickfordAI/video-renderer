import { afterEach, describe, expect, it, vi } from 'vitest';
import { DssShotPlanner } from './shot-planner.js';
import { ShotGenerator, type GeneratedShot } from './shot-generation.js';
import { ShotScheduler } from './shot-scheduler.js';
import { generateVideo } from './fal.js';
import { expandShotPrompt } from './shot-expansion.js';
vi.mock('./fal.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./shot-expansion.js', () => ({ expandShotPrompt: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const shot = () => new DssShotPlanner({ characters: { Alex: { imageUrl: 'https://example.com/alex.png' } } })
  .planGroup([{ command: 'talk', args: { character: 'Alex', dialogue: 'Ready.', audio_duration: 5 } }], 'g', 'b').shots[0];
const generator = (promptMode?: 'template' | 'llm', promptApiKey?: string) => {
  const signal = new AbortController().signal;
  return new ShotGenerator({ renderMode: 'fal-max-ref2v', continuity: 'none', resolution: '480P', apiKey: 'fal-fixture',
    promptMode, promptApiKey, scheduler: new ShotScheduler<GeneratedShot>(1, 15, signal), signal });
};
describe('paid prompt policy boundary', () => {
  it('defaults to A plus balanced without calling the LLM', async () => {
    vi.mocked(generateVideo).mockResolvedValue({ videoUrl: 'https://example.com/a.mp4' } as Awaited<ReturnType<typeof generateVideo>>);
    await generator().schedule(shot()).job.result;
    expect(expandShotPrompt).not.toHaveBeenCalled();
    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({ promptExpansionMode: 'balanced', prompt: expect.stringContaining('Alex stays in place throughout the shot') }), expect.anything());
  });
  it('submits the LLM output with expansion disabled and the same resolved reference array', async () => {
    vi.mocked(expandShotPrompt).mockResolvedValue({ prompt: 'validated expanded prompt' } as Awaited<ReturnType<typeof expandShotPrompt>>);
    vi.mocked(generateVideo).mockResolvedValue({ videoUrl: 'https://example.com/llm.mp4' } as Awaited<ReturnType<typeof generateVideo>>);
    const generated = await generator('llm', 'anthropic-fixture').schedule(shot()).job.result;
    expect(expandShotPrompt).toHaveBeenCalledTimes(1);
    const resolved = vi.mocked(expandShotPrompt).mock.calls[0][0];
    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'validated expanded prompt', promptExpansionMode: 'disabled', referenceImageUrls: resolved.imageReferences.map(r => r.url) }), expect.anything());
    expect(generated.submittedPrompt).toBe('validated expanded prompt');
  });
  it('stops before video submission on missing credentials or expansion failure', async () => {
    expect(() => generator('llm').schedule(shot())).toThrow('ANTHROPIC_API_KEY');
    expect(expandShotPrompt).not.toHaveBeenCalled();
    vi.mocked(expandShotPrompt).mockRejectedValue(new Error('Dialogue validation failed'));
    await expect(generator('llm', 'anthropic-fixture').schedule(shot()).job.result).rejects.toThrow('Dialogue validation failed');
    expect(expandShotPrompt).toHaveBeenCalledTimes(1);
    expect(generateVideo).not.toHaveBeenCalled();
  });
});
