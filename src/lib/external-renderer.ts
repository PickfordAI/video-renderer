import type { RenderMode } from '../../server/render-mode';
import type { ShotPlannerSettings } from '../../server/shot-planner';

export interface ExternalRendererConnectionStatus {
  runId: string;
  state: 'connecting' | 'running' | 'ended' | 'stopped' | 'failed';
  sessionId: string | null;
  hlsUrl: string | null;
  clipsRendered: number;
  dssCommandsRendered: number;
  failures: string[];
}

export interface ExternalRendererStoryStart {
  renderMode?: RenderMode;
  initialImageUrl?: string;
  generationConcurrency?: number;
  maxBufferedSeconds?: number;
  resolution?: '480P' | '768P';
  clipDurationSeconds?: number;
  shotPlanner?: ShotPlannerSettings;
  storyId: number;
  roomId: string;
  storyMessageChannelId: string;
  storyConfig: Record<string, unknown>;
  storyStatusBaseUrl: string;
  storyStatusToken: string;
}

async function connectionRequest(
  method: 'GET' | 'POST' | 'DELETE',
  story?: ExternalRendererStoryStart,
): Promise<ExternalRendererConnectionStatus> {
  const response = await fetch('/api/external-renderer/connection', {
    method,
    headers: story ? { 'Content-Type': 'application/json' } : undefined,
    body: story ? JSON.stringify(story) : undefined,
  });
  const body = await response.json() as ExternalRendererConnectionStatus & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Renderer Platform connection failed (${response.status})`);
  return body;
}

export async function startExternalRendererConnection(story: ExternalRendererStoryStart): Promise<ExternalRendererConnectionStatus> {
  const initial = await connectionRequest('POST', story);
  try {
    const deadline = Date.now() + 30_000;
    let status = initial;
    while (status.state === 'connecting' && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      status = await connectionRequest('GET');
    }
    if (status.state !== 'running') {
      throw new Error(status.failures.at(-1) ?? 'Renderer Platform connection did not become ready');
    }
    return status;
  } catch (error) {
    await stopExternalRendererConnection(initial.runId).catch(() => undefined);
    throw error;
  }
}

export function getExternalRendererConnection(): Promise<ExternalRendererConnectionStatus> {
  return connectionRequest('GET');
}

export async function stopExternalRendererConnection(runId?: string): Promise<void> {
  const path = runId
    ? `/api/external-renderer/connection/${encodeURIComponent(runId)}`
    : '/api/external-renderer/connection';
  const response = await fetch(path, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Could not stop Renderer Platform connection (${response.status})`);
  }
}
