import type { GenerateVideoInput, GenerateVideoResult } from './fal.js';

const TERMINAL_FAILURES = new Set(['failed', 'cancelled']);

export class MiniMaxVideoError extends Error {
  constructor(message: string) { super(message); this.name = 'MiniMaxVideoError'; }
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new MiniMaxVideoError(`${label} failed (${response.status}): ${text.slice(0, 400)}`);
  try { return JSON.parse(text) as T; }
  catch { throw new MiniMaxVideoError(`${label} returned invalid JSON`); }
}

function elapsedSeconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) / 10) / 100;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timeout); reject(signal.reason); }, { once: true });
  });
}

export async function generateMiniMaxVideo(
  input: GenerateVideoInput,
  options: {
    apiKey: string;
    baseUrl?: string;
    textModel?: string;
    referenceModel?: string;
    fetchImpl?: typeof fetch;
    pollIntervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<GenerateVideoResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? 'https://api.minimax.io').replace(/\/$/, '');
  const generationMode = input.referenceImageUrls?.length || input.referenceAudioUrls?.length ? 'reference' : 'text';
  const model = generationMode === 'reference'
    ? options.referenceModel ?? 'MiniMax-H3'
    : options.textModel ?? 'MiniMax-H3-Max';
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
  for (const url of input.referenceImageUrls ?? []) content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
  for (const url of input.referenceAudioUrls ?? []) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
  const headers = { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' };
  const startedAt = performance.now();
  const submittedAt = performance.now();
  const submitted = await fetchImpl(`${baseUrl}/v2/video_generation`, {
    method: 'POST', headers, signal: options.signal,
    body: JSON.stringify({ model, content, duration: input.duration, resolution: input.resolution, ratio: input.aspectRatio }),
  });
  const created = await readJson<{ task_id?: unknown }>(submitted, 'MiniMax submit');
  if (typeof created.task_id !== 'string' || !created.task_id) throw new MiniMaxVideoError('MiniMax submit response is missing task_id');
  const taskId = created.task_id;
  const submitSeconds = elapsedSeconds(submittedAt);
  const queueStartedAt = performance.now();
  let polls = 0;
  for (;;) {
    if (performance.now() - startedAt > (options.timeoutMs ?? 300_000)) throw new MiniMaxVideoError(`MiniMax request ${taskId} timed out`);
    await delay(options.pollIntervalMs ?? 10_000, options.signal);
    const response = await fetchImpl(`${baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`, { headers, signal: options.signal });
    const result = await readJson<{ task?: { status?: unknown; content?: { url?: unknown }; error?: unknown } }>(response, 'MiniMax status poll');
    polls += 1;
    const status = typeof result.task?.status === 'string' ? result.task.status.toLowerCase() : '';
    if (status === 'succeeded') {
      const videoUrl = result.task?.content?.url;
      if (typeof videoUrl !== 'string' || !videoUrl) throw new MiniMaxVideoError('MiniMax result is missing content.url');
      return { requestId: taskId, videoUrl, expandedPrompt: null, generationMode,
        timings: { submitSeconds, queueSeconds: elapsedSeconds(queueStartedAt), totalSeconds: elapsedSeconds(startedAt), polls } };
    }
    if (TERMINAL_FAILURES.has(status)) throw new MiniMaxVideoError(`MiniMax request ${taskId} ended ${status}: ${JSON.stringify(result.task?.error ?? null)}`);
  }
}
