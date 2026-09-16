import type { PlannedShot } from './shot-planner.js';
import { selectShotPromptReferences } from './shot-prompt.js';
import { buildShotBrief, type ShotBrief } from './shot-brief.js';
import { projectShotBrief, type ShotGenerationBrief } from './shot-generation-brief.js';
import { H3_EXPANSION_INSTRUCTIONS } from './shot-expansion-instructions.js';

export const EXPANSION_SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const;

/** Cheap checks for the observed dropped/rewritten dialogue and invented asset bindings. */
export function validateExpandedPrompt(prompt: string, input: ShotBrief | ShotGenerationBrief): void {
  const brief = 'source' in input ? projectShotBrief(input) : input;
  if (prompt.startsWith('REVIEW_NEEDED')) throw new Error(prompt);
  const headings = [...prompt.matchAll(/^([a-z_]+):\s*$/gm)].map(m => m[1]);
  if (headings.join(',') !== EXPANSION_SECTIONS.join(',')) throw new Error('Expansion must contain the six H3 sections in order');
  const dialogue = [...prompt.matchAll(/<d>\[English\]\s*([\s\S]*?)<\/d>/g)].map(m => m[1].trim()).join(' ');
  if (dialogue !== (brief.speech?.dialogue ?? '')) throw new Error('Expansion changed or omitted the exact dialogue');
  const prose = prompt.replace(/<d>[\s\S]*?<\/d>/g, '');
  if (/\b(?:no|not|never|without|avoid|exclude|rather than|don't|cannot)\b/i.test(prose)) throw new Error('Expansion contains negative generation directions');
  const definitions = prompt.split(/^summary:\s*$/m)[0];
  const subjects = new Set([...definitions.matchAll(/<Subject (\d+)>/g)].map(m => m[1]));
  if (subjects.size !== brief.visibleCast.length) throw new Error('Expansion Subject definitions must match the visible cast');
  if (brief.speech?.visible && !/<Subject \d+>\s*\(S1\)/.test(prompt.split(/^detailed_description:\s*$/m)[1] ?? '')) throw new Error('Expansion omitted native speaker binding');
  const detail = (prose.split(/^detailed_description:\s*$/m)[1] ?? '').split(/^overall_soundscape:/m)[0];
  if (brief.visibleCast.length === 1 && !detail.includes(`The frame contains ${brief.visibleCast[0].name} alone.`)) {
    throw new Error('Expansion omitted the single-visible-person frame instruction');
  }
  // Internal target relationships guide gaze; anonymous people are not visual prompt subjects.
  // Voice attribution for an authored off-frame speaker remains valid.
  if (/\b(?:person|people|counterpart|listener|subject|character|someone|somebody|anyone)\b[^.!?\n]{0,35}\b(?:(?:beyond|outside) (?:the )?(?:frame|shot|view)|off[ -]?(?:screen|frame))\b|\b(?:off[ -]?screen|off[ -]?frame|unseen|invisible|nonexistent|implied)\s+(?:(?:conversational|conversation)\s+)?(?:person|people|counterpart|listener|subject|character|someone|somebody|anyone)\b/i.test(prose)) {
    throw new Error('Expansion describes an anonymous hidden target');
  }
  for (const subject of brief.visibleCast) {
    if (subject.gaze.directionSource === 'authored' && !detail.includes(`${subject.name} looks ${subject.eyeline}.`)) {
      throw new Error(`Expansion omitted ${subject.name}'s authored gaze instruction`);
    }
    if (subject.gaze.target === 'off-frame-character') {
      const sentence = detail.split(/(?<=[.!?])\s+/).find(s => s.includes(`${subject.name} looks `));
      if (subject.gaze.directionSource !== 'authored' && !/\b(?:frame[ -](?:left|right)|upward|downward|off-axis conversational eyeline)\b/i.test(sentence ?? '')) {
        throw new Error(`Expansion omitted ${subject.name}'s explicit gaze toward the hidden target`);
      }
    }
  }
  for (const match of prompt.matchAll(/<Subject (\d+)>/g)) if (!subjects.has(match[1])) throw new Error('Expansion uses an undefined Subject');
  if (brief.composition && /\b(?:tighten(?:ed|ing)?|refram(?:e|ed|ing)|zoom(?:s|ed|ing)?)\b/i.test(prose)) throw new Error('Expansion changes the prepared framing');
  for (const [kind, size] of [['Picture', brief.references.length], ['Audio', brief.audioReferences.length]] as const) {
    for (const match of prose.matchAll(new RegExp(`<${kind} (\\d+)>`, 'g'))) {
      if (+match[1] < 1 || +match[1] > size) throw new Error(`Expansion invented a ${kind} reference`);
    }
  }
  if ([...prose.matchAll(/\[Shot \d+\]/g)].some(m => m[0] !== '[Shot 1]')) throw new Error('Expansion introduced another shot');
}

export interface ExpansionResult { prompt: string; model: string; usage: unknown; raw: unknown; brief: ShotBrief }

/** One image-aware LLM call. This function cannot submit a video job. */
export async function expandShotPrompt(shot: PlannedShot, options: {
  apiKey: string; model: string; signal?: AbortSignal; fetchImpl?: typeof fetch;
  onResponse?: (response: unknown) => Promise<void>;
}): Promise<ExpansionResult> {
  const brief = buildShotBrief(shot);
  const refs = selectShotPromptReferences(shot.promptInput, shot.imageReferences, shot.audioReferences);
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const content: unknown[] = [];
  for (const [index, ref] of refs.images.entries()) {
    let dataUrl = ref.url;
    if (!dataUrl.startsWith('data:')) {
      const response = await fetchImpl(dataUrl, { signal });
      if (!response.ok) throw new Error(`Expansion image ${index + 1} failed (${response.status})`);
      dataUrl = `data:${response.headers.get('content-type')?.split(';')[0]};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
    }
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
    if (!match) throw new Error(`Expansion image ${index + 1} has unsupported encoding`);
    content.push({ type: 'text', text: `Picture ${index + 1}: ${ref.role}${ref.role === 'character' ? ` for ${ref.name}` : ''}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
  }
  content.push({ type: 'text', text: `Resolved shot brief:\n${JSON.stringify(projectShotBrief(brief), null, 2)}\n\nWrite the final six-section prompt as plain text.` });
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: options.model, max_tokens: 4096, system: H3_EXPANSION_INSTRUCTIONS, messages: [{ role: 'user', content }] }),
  });
  // No automatic POST retry: retain the response for inspection even when validation fails.
  if (!response.ok) throw new Error(`Prompt expansion failed (${response.status}); request was not retried`);
  const raw = await response.json() as { model: string; content: Array<{ type: string; text?: string }>; usage: unknown; stop_reason: string };
  await options.onResponse?.(raw);
  if (raw.stop_reason !== 'end_turn') throw new Error(`Prompt expansion incomplete (${raw.stop_reason})`);
  const prompt = raw.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n').trim();
  validateExpandedPrompt(prompt, brief);
  return { prompt, model: raw.model, usage: raw.usage, raw, brief };
}
