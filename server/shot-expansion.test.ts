import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseDssFrame } from './external-renderer.js';
import { MinimaxSceneAssetCache } from './scene-context.js';
import { DssShotPlanner } from './shot-planner.js';
import { projectShotBrief } from './shot-generation-brief.js';
import { buildShotBrief } from './shot-brief.js';
import { formatPositiveTemplate } from './shot-template.js';
import { expandShotPrompt, validateExpandedPrompt } from './shot-expansion.js';

async function shot(gaze?: string, emotion?: string) {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/prepared-coverage-dss.json', import.meta.url), 'utf8'));
  const frame = parseDssFrame(raw);
  const cache = new MinimaxSceneAssetCache({ fetchImpl: async url => new Response(`downloaded:${new URL(String(url)).pathname.split('/').at(-1)}`, { headers: { 'content-type': 'image/png' } }) });
  const planner = new DssShotPlanner();
  planner.applySceneContext(await cache.resolve(frame.sceneContext!), 0);
  return planner.planGroup([...(emotion ? [{ command: 'set emotion', args: { character: 'Theo', emotion } }] : []), ...(gaze ? [{ command: 'look', args: { character: 'Theo', target: { name: gaze, bias: 'eyes' } } }] : []), { command: 'talk', args: { character: 'Theo', respondent: 'Maya', camera_shot: 'Character_CloseUp', dialogue: '[measured] This is not final, [earnest] but it is useful.', tone: 'thoughtful', audio_duration: 5 } }], 'g', 'b').shots[0];
}
const expansion = (dialogue: string) => `subject_definitions:\n<Subject 1> is Theo from <Picture 2>.\n\nsummary:\n[reference generation + keyframe completion] Five-second close-up.\n\nretention_analysis:\n<Picture 1> ([Shot 1]): fully_preserved.\n\ndetailed_description:\n[Shot 1] The frame contains Theo alone. Theo looks toward frame left. <Subject 1> (S1) speaks: <d>[English] ${dialogue}</d>\n\noverall_soundscape:\nQuiet room tone.\n\nnon_diegetic_music:\nN/A`;

describe('DSS prompt trial', () => {
  it('preserves phrase directions and spoken negatives while removing hidden cast from the brief and template', async () => {
    const planned = await shot();
    const brief = buildShotBrief(planned);
    expect(brief.speech?.deliveryBeats).toEqual([{ phrase: 'This is not final,', directions: ['measured'] }, { phrase: 'but it is useful.', directions: ['earnest'] }]);
    expect(brief.visibleCast.map(s => s.name)).toEqual(['Theo']);
    expect(brief.source.subjects.some(s => s.name === 'Maya')).toBe(true);
    expect(JSON.stringify(projectShotBrief(brief))).not.toContain('Maya');
    const template = formatPositiveTemplate(brief);
    expect(template).not.toContain('Maya');
    expect(template).toContain('<d>[English] This is not final, but it is useful.</d>');
    expect(brief.visibleCast[0].eyeline).toBe('toward the person beyond the frame');
    expect(brief.visibleCast[0].gaze.source).toBe('speech-listener');
    expect(brief.references.map(r => r.role)).toEqual(['composition', 'character']);
  });

  it('treats a composition as an opening state while retaining authored ending changes', async () => {
    const planned = structuredClone(await shot());
    const subject = planned.promptInput.subjects.find(s => s.visible)!;
    subject.startingPosture = 'standing';
    subject.resultingPosture = 'standing';
    subject.resultingBlocking = subject.startingBlocking;
    const initial = buildShotBrief(planned);
    expect(initial.visibleCast[0].ending).toBe('');
    expect(formatPositiveTemplate(initial)).not.toContain('resulting_state:');
    subject.resultingPosture = 'seated';
    const changed = buildShotBrief(planned);
    expect(changed.visibleCast[0].ending).toBe('seated');
    expect(formatPositiveTemplate(changed)).toContain('resulting_state: Theo: seated.');
  });

  it('preserves explicit DSS gaze over the respondent, including an authored camera look', async () => {
    const planned = structuredClone(await shot('camera'));
    const subject = planned.promptInput.subjects.find(s => s.name === 'Theo')!;
    const brief = buildShotBrief(planned);
    expect(brief.visibleCast[0].gaze.source).toBe('dss-look');
    expect(brief.visibleCast[0].eyeline).toBe('into the camera');
    expect(() => validateExpandedPrompt(expansion(brief.speech!.dialogue), brief)).toThrow('authored gaze');
    const correct = expansion(brief.speech!.dialogue).replace('Theo looks toward frame left.', 'Theo looks into the camera.');
    expect(() => validateExpandedPrompt(correct, brief)).not.toThrow();
    subject.gaze = 'Maya (eye contact)';
    const hidden = buildShotBrief(planned);
    expect(hidden.visibleCast[0].gaze).toMatchObject({ source: 'dss-look', target: 'off-frame-character' });
    expect(JSON.stringify(projectShotBrief(hidden))).not.toContain('Maya');
  });

  it('expresses hidden-target attention as screen direction or an unsided best effort', async () => {
    const brief = buildShotBrief(await shot());
    const valid = expansion(brief.speech!.dialogue);
    const sentence = 'Theo looks toward frame left.';
    expect(() => validateExpandedPrompt(valid.replace(sentence, 'Theo follows the eyeline in <Picture 1>.'), brief)).toThrow('explicit gaze');
    expect(() => validateExpandedPrompt(valid.replace(sentence, 'Theo looks into the camera.'), brief)).toThrow('explicit gaze');
    expect(() => validateExpandedPrompt(valid.replace(sentence, 'Theo looks with an off-axis conversational eyeline.'), brief)).not.toThrow();
  });

  it('carries an active delivery instruction into a split continuation', () => {
    const planner = new DssShotPlanner();
    const planned = planner.planGroup([{ command: 'talk', args: { character: 'Theo', dialogue: '[firm] One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.', audio_duration: 20 } }], 'g', 'b');
    expect(planned.shots.length).toBeGreaterThan(1);
    expect(planned.shots[1].promptInput.speech?.deliveryBeats?.[0].directions).toEqual(['firm']);
    expect(planned.shots.map(s => s.dialogue).join(' ')).toBe('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.');
  });

  it('rejects changed dialogue and invented audio before producing a usable expansion', async () => {
    const brief = buildShotBrief(await shot());
    const valid = expansion(brief.speech!.dialogue);
    expect(() => validateExpandedPrompt(valid, brief)).not.toThrow();
    expect(() => validateExpandedPrompt(valid.replace('not final', 'final'), brief)).toThrow('exact dialogue');
    expect(() => validateExpandedPrompt(valid.replace('Quiet room tone.', '<Audio 1> supplies speech.'), brief)).toThrow('Audio reference');
    expect(() => validateExpandedPrompt(valid.replaceAll('<Subject 1>', 'Theo'), brief)).toThrow('Subject definitions');
    expect(() => validateExpandedPrompt(valid.replace('Quiet room tone.', 'No background noise.'), brief)).toThrow('negative generation');
    expect(() => validateExpandedPrompt(valid.replace('Five-second close-up.', 'The crop is tightened.'), brief)).toThrow('prepared framing');
    expect(() => validateExpandedPrompt(valid.replace('The frame contains Theo alone. ', ''), brief)).toThrow('single-visible-person');
    expect(() => validateExpandedPrompt(valid.replace('summary:', '<Subject 2> is a listener.\n\nsummary:'), brief)).toThrow('Subject definitions');
    for (const hidden of ['The person beyond the frame listens.', 'A thoughtful line to someone beyond the frame.', 'A line to someone just beyond the frame.', 'He speaks to somebody outside the frame.', 'He speaks to anyone offscreen.', 'He turns toward an off-frame listener.', 'Toward the person he is speaking with beyond the frame.']) {
      expect(() => validateExpandedPrompt(valid.replace('Five-second close-up.', hidden), brief)).toThrow('anonymous hidden target');
      expect(() => validateExpandedPrompt(expansion(hidden), { ...brief, source: { ...brief.source, speech: { ...brief.source.speech!, dialogue: hidden } } })).not.toThrow();
    }
    expect(() => validateExpandedPrompt(valid.replace('Five-second close-up.', 'Theo directs his speech off frame to the right.'), brief)).not.toThrow();
    const offFrameSpeech = { ...brief, source: { ...brief.source, speech: { ...brief.source.speech!, speaker: 'Maya' } } };
    expect(() => validateExpandedPrompt(valid.replace('<Subject 1> (S1) speaks:', 'Maya (voice from beyond the frame) speaks:'), offFrameSpeech)).not.toThrow();
  });

  it('rejects an oversized LLM image copy before calling Anthropic', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(expandShotPrompt(await shot(), { apiKey: 'test', model: 'test', fetchImpl,
      imagePreprocessor: async () => ({ bytes: new Uint8Array(1500_001), contentType: 'image/jpeg' }),
    })).rejects.toThrow('image copy exceeds');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends actual ordered images plus the filtered brief in one LLM request, preserving the response', async () => {
    const planned = structuredClone(await shot('Maya', 'amused'));
    const performer = planned.promptInput.subjects.find(s => s.name === 'Theo')!;
    performer.resultingBlocking = 'Theo is standing at foreground rug right';
    performer.bodyOrientation = 'Open front three-quarter torso, inward toward Maya';
    planned.promptInput.subjects.find(s => s.name === 'Maya')!.resultingBlocking = 'Maya is standing at foreground rug center';
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      expect(request.system[0].text).toContain('six-section');
      expect(request.max_tokens).toBe(16000);
      expect(request.output_config).toEqual({ effort: 'low' });
      expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
      const blocks = request.messages[0].content;
      expect(blocks.filter((b: { type: string }) => b.type === 'image').map((b: { source: { data: string } }) => Buffer.from(b.source.data, 'base64').toString())).toEqual(['copy:downloaded:theo-close.png', 'copy:downloaded:theo.png']);
      expect(blocks.at(-1).text).not.toContain('Maya');
      const projected = JSON.parse(blocks.at(-1).text.split('Resolved shot brief:\n')[1].split('\n\nWrite the final')[0]);
      expect(projected.visibleCast[0]).toMatchObject({ emotion: 'amused', emotionProvenance: 'explicit-dss', gaze: { source: 'dss-look', target: 'off-frame-character' } });
      expect(projected.relationships).toContainEqual(expect.objectContaining({ relation: 'looks-at',
        target: "the person beyond the frame (toward room-left from Theo's position)",
        targetDirection: expect.objectContaining({ horizontal: 'left', coordinateSpace: 'room-relative' }) }));
      expect(projected.visibleCast[0].bodyOrientation).toContain('toward room-left');
      expect(projected.visibleCast[0].eyeline).toContain('toward room-left');
      expect(projected.speech.tone).toBe('thoughtful');
      return Response.json({ model: 'test-model', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: expansion(planned.dialogue!) }] });
    });
    const onResponse = vi.fn(async () => {});
    const result = await expandShotPrompt(planned, { apiKey: 'test', model: 'test-model', fetchImpl, onResponse, imagePreprocessor: async bytes => ({ bytes: Buffer.from('copy:' + Buffer.from(bytes).toString()), contentType: 'image/jpeg' }) });
    expect(planned.imageReferences[0].url).not.toContain('copy:');
    expect(result.prompt).toContain(planned.dialogue);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });
});
