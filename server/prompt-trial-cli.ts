import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { loadDssRecording } from './dss-replay.js';
import { parseDssFrame } from './external-renderer.js';
import { MinimaxSceneAssetCache } from './scene-context.js';
import { DssShotPlanner, type PlannedShot, type ShotPlannerSettings } from './shot-planner.js';
import { buildShotBrief } from './shot-brief.js';
import { formatPositiveTemplate } from './shot-template.js';
import { expandShotPrompt } from './shot-expansion.js';
import { projectShotBrief } from './shot-generation-brief.js';
import { H3_EXPANSION_INSTRUCTIONS } from './shot-expansion-instructions.js';

/** Prompt-only prototype: real DSS compiler, real image bytes, optional single LLM request. */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    dss: { type: 'string' }, group: { type: 'string' }, out: { type: 'string' },
    'asset-map': { type: 'string' }, 'shot-planner': { type: 'string' }, baseline: { type: 'string' },
    expand: { type: 'boolean' }, model: { type: 'string', default: 'claude-opus-5' },
    'env-file': { type: 'string' }, seed: { type: 'string', default: '2026091531' }, help: { type: 'boolean' },
  } });
  if (values.help || !values.dss || !values.group || !values.out) {
    console.log('Usage: npm run prompt:trial -- --dss FILE --group ID --out NEW_DIR [--asset-map URL_TO_LOCAL_JSON] [--shot-planner JSON] [--baseline PROMPT_FILE] [--expand --model claude-opus-5 --env-file FILE] [--seed N]\nProduces prompt artifacts only. --expand makes one paid image-aware LLM call. No video jobs are submitted.');
    process.exitCode = values.help ? 0 : 2; return;
  }
  if (values['env-file']) dotenv.config({ path: resolve(values['env-file']), quiet: true });
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a nonnegative safe integer');
  if (values.expand && !process.env.ANTHROPIC_API_KEY) throw new Error('--expand requires ANTHROPIC_API_KEY');
  const out = resolve(values.out);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 }); // Existing output is an error, preventing accidental paid retries.
  const save = (name: string, content: string) => writeFile(join(out, name), content, { mode: 0o600, flag: 'wx' });
  const json = (name: string, data: unknown) => save(name, JSON.stringify(data, null, 2) + '\n');
  const assetMap: Record<string, string> = values['asset-map'] ? JSON.parse(await readFile(resolve(values['asset-map']), 'utf8')) : {};
  const assetBase = values['asset-map'] ? dirname(resolve(values['asset-map'])) : process.cwd();
  const readAsset: typeof fetch = async (url, options) => {
    const local = assetMap[String(url)];
    if (!local) return fetch(url, options);
    const file = resolve(assetBase, local);
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(file)];
    if (!type) throw new Error('Unsupported local reference image extension');
    return new Response(new Uint8Array(await readFile(file)), { headers: { 'content-type': type } });
  };
  const raw = await readFile(resolve(values.dss), 'utf8');
  const parsed = (() => { try { return JSON.parse(raw); } catch { return undefined; } })();
  const payloads = loadDssRecording(parsed?.command_groups ? JSON.stringify({ script: parsed }) : raw);
  const settings: ShotPlannerSettings = values['shot-planner'] ? JSON.parse(await readFile(resolve(values['shot-planner']), 'utf8')) : {};
  const planner = new DssShotPlanner({ ...settings, referenceMode: 'reference', defaultDurationSeconds: 5 });
  const cache = new MinimaxSceneAssetCache({ fetchImpl: readAsset });
  let selected: PlannedShot | undefined;
  let rootSceneStateApplied = false;
  outer: for (const payload of payloads) {
    const frame = parseDssFrame(payload);
    planner.applySceneContext(frame.sceneContext ? await cache.resolve(frame.sceneContext) : null, frame.sceneIndex);
    const recorded = (payload as { scene_state?: unknown; script?: { scene_state?: unknown } });
    const frameState = recorded.scene_state ?? recorded.script?.scene_state;
    const sceneState = frameState ?? (!rootSceneStateApplied ? parsed?.scene_state ?? parsed?.script?.scene_state : undefined);
    if (sceneState) { planner.applyRecordedSceneState(sceneState); rootSceneStateApplied = true; }
    for (const group of frame.groups) {
      const plan = planner.planGroup(group.commands, group.id, frame.storyBlockId);
      if (group.id !== values.group) continue;
      if (plan.shots.length !== 1) throw new Error('Choose a group producing exactly one shot for this bounded trial');
      selected = plan.shots[0]; break outer;
    }
  }
  if (!selected) throw new Error('Requested DSS group was not found');
  const brief = buildShotBrief(selected);
  const template = formatPositiveTemplate(brief);
  await save('positive-template.txt', template + '\n');
  await save('planned-template.txt', selected.prompt + '\n');
  await save('llm-instructions.txt', H3_EXPANSION_INSTRUCTIONS);
  await json('shot-brief.json', brief);
  await json('generation-brief.json', projectShotBrief(brief));
  await json('provenance.json', { dss: resolve(values.dss), dssSha256: createHash('sha256').update(raw).digest('hex'), groupId: selected.groupId, shotId: selected.id, assetMap: values['asset-map'] ? resolve(values['asset-map']) : null });
  const images: Array<{ label: string; name: string; role: string; path: string; sha256: string }> = [];
  for (const [i, ref] of selected.imageReferences.entries()) {
    const response = await readAsset(ref.url);
    if (!response.ok) throw new Error(`Selected image ${i + 1} failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type')?.split(';')[0];
    const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : undefined;
    if (!extension) throw new Error('Unsupported selected image type');
    const path = `image-${i + 1}.${extension}`;
    await writeFile(join(out, path), bytes, { mode: 0o600, flag: 'wx' });
    images.push({ label: ref.label, name: ref.name, role: ref.role, path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await json('references.json', { images, audios: selected.audioReferences });
  const request = (prompt: string, mode: 'balanced' | 'disabled') => ({ prompt, prompt_expansion_mode: mode, duration: selected.durationSeconds, resolution: '480P', aspect_ratio: '16:9', seed, enable_safety_checker: true, reference_image_urls: selected.referenceImageUrls, reference_audio_urls: selected.referenceAudioUrls });
  await json('positive-balanced-request.json', request(template, 'balanced'));
  if (values.baseline) {
    const original = (await readFile(resolve(values.baseline), 'utf8')).trim();
    await save('original-template.txt', original + '\n');
    await json('original-balanced-request.json', request(original, 'balanced'));
  }
  console.log(`Compiled ${selected.speaker ?? 'action'}: ${selected.durationSeconds}s, ${images.length} images. Positive template saved.`);
  if (values.expand) {
    await json('expansion-attempt.json', { startedAt: new Date().toISOString(), model: values.model, status: 'attempted_once' });
    const result = await expandShotPrompt(selected, { apiKey: process.env.ANTHROPIC_API_KEY!, model: values.model!, onResponse: response => json('llm-response.json', response) });
    await save('llm-expanded.txt', result.prompt + '\n');
    await json('llm-disabled-request.json', request(result.prompt, 'disabled'));
    await json('expansion-result.json', { model: result.model, usage: result.usage, validation: 'passed', videoSubmitted: false });
    console.log(`Expanded with ${result.model}; exact dialogue, section order and asset bindings passed. No video submitted.`);
  }
  console.log(`Artifacts: ${out}`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
