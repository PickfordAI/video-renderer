import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import dotenv from 'dotenv';

import { formatReplaySummary, loadDssRecording, replayDss, type ReplayOptions } from './dss-replay.js';
import type { ContinuityStrategy, RenderMode } from './render-mode.js';
import type { ShotPlannerSettings } from './shot-planner.js';

/** PIC-1410: `npm run replay -- --dss recording.jsonl [--from N --to M] [--render]`. */
const USAGE = `Usage: npm run replay -- --dss <file> [options]

  --dss <file>            DSS recording: JSON array, JSONL, or {received_at,event} capture rows
  --episode <id>          Only this episode_id (default: all)
  --from <n> --to <n>     Inclusive payload sequence range; earlier payloads still replay staging
  --model <m>             fal-max-ref2v (default) | fal-turbo-i2v
  --continuity <c>        camera-anchors | none | last-frame-chain (default: model default)
  --concurrency <n>       1-32 (default 2)        --budget <s>   unplayed-video budget, 5-150 (default 30)
  --resolution <r>        480P (default) | 768P   --clip-seconds <s>  default shot length, 5-15 (default 5)
  --handoff <file>        Read rendererConfig/shotPlanner/initialImageUrl/resolution/clipDurationSeconds from a handoff
  --shot-planner <file>   JSON shotPlanner settings (cast/set images, style, marks); overrides the handoff's
  --initial-image <url>   HTTPS opening frame (Turbo)
  --render                Submit paid fal jobs (FAL_KEY), download clips, assemble story.mp4
  --out <dir>             Output directory (default .renderer/replay/<timestamp>)
  --json                  Print the full result as JSON instead of the summary
`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const integer = (name: string) => { const raw = option(name); if (raw === undefined) return undefined; const value = Number(raw); if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`); return value; };

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  if (flag('help') || !option('dss')) { process.stdout.write(USAGE); process.exitCode = option('dss') ? 0 : 2; return; }
  const recording = loadDssRecording(await readFile(resolve(option('dss')!), 'utf8'));
  const handoff = option('handoff') ? JSON.parse(await readFile(resolve(option('handoff')!), 'utf8')) as Record<string, unknown> : {};
  const shotPlanner = option('shot-planner')
    ? JSON.parse(await readFile(resolve(option('shot-planner')!), 'utf8')) as ShotPlannerSettings
    : handoff.shotPlanner as ShotPlannerSettings | undefined;
  const handoffConfig = (handoff.rendererConfig ?? {}) as Record<string, unknown>;
  const continuity = option('continuity') ?? handoffConfig.continuity as string | undefined;
  const options: ReplayOptions = {
    rendererConfig: {
      model: (option('model') ?? handoffConfig.model ?? 'fal-max-ref2v') as RenderMode,
      ...(continuity ? { continuity: continuity as ContinuityStrategy } : {}),
      concurrency: integer('concurrency') ?? handoffConfig.concurrency as number | undefined,
      maxBufferedSeconds: integer('budget') ?? handoffConfig.maxBufferedSeconds as number | undefined,
    },
    resolution: (option('resolution') ?? handoff.resolution) as '480P' | '768P' | undefined,
    clipDurationSeconds: integer('clip-seconds') ?? handoff.clipDurationSeconds as number | undefined,
    shotPlanner,
    initialImageUrl: option('initial-image') ?? handoff.initialImageUrl as string | undefined,
    episodeId: integer('episode'),
    from: integer('from'),
    to: integer('to'),
  };
  for (const key of ['concurrency', 'maxBufferedSeconds'] as const) if (options.rendererConfig![key] === undefined) delete options.rendererConfig![key];
  const outDir = resolve(option('out') ?? join('.renderer', 'replay', new Date().toISOString().replace(/[:.]/g, '-')));
  if (flag('render')) {
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) throw new Error('--render requires FAL_KEY in the environment or .env');
    const plan = await replayDss(recording, options);
    process.stderr.write(`Submitting ${plan.shots.length} paid video job(s), ${plan.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)}s of video, to fal.\n`);
    options.render = { apiKey, outDir };
  }
  const result = await replayDss(recording, options);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const reportPath = join(outDir, flag('render') ? 'run.json' : 'plan.json');
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(flag('json') ? JSON.stringify(result, null, 2) + '\n' : `${formatReplaySummary(result)}\nreport: ${reportPath}\n`);
  if (result.output?.failures) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
