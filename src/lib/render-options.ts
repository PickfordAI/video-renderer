import { parseInitialImageUrl, parseRenderMode } from '../../server/render-mode';
import type { ShotPlannerSettings } from '../../server/shot-planner';
import type { RendererSettings } from './types';

export const DEFAULT_RENDER_OPTIONS = {
  renderMode: 'auto' as const,
  initialImageUrl: '',
  generationConcurrency: 2,
  maxBufferedSeconds: 30,
  styleDescription: '',
};

/** Invalid old preferences must not silently select a different paid provider. */
export function loadRenderOptions(value: Partial<RendererSettings>): Omit<typeof DEFAULT_RENDER_OPTIONS, 'renderMode'> & { renderMode: RendererSettings['renderMode'] } {
  return {
    renderMode: parseRenderMode(value.renderMode),
    initialImageUrl: typeof value.initialImageUrl === 'string' ? value.initialImageUrl : '',
    generationConcurrency: Number.isInteger(value.generationConcurrency) && value.generationConcurrency! >= 1 && value.generationConcurrency! <= 8 ? value.generationConcurrency! : 2,
    maxBufferedSeconds: Number.isInteger(value.maxBufferedSeconds) && value.maxBufferedSeconds! >= 5 && value.maxBufferedSeconds! <= 120 ? value.maxBufferedSeconds! : 30,
    styleDescription: typeof value.styleDescription === 'string' ? value.styleDescription : '',
  };
}

export function renderSettingsError(settings: RendererSettings, health?: { falKeyConfigured: boolean; anyKeyConfigured: boolean }): string | null {
  try {
    const mode = parseRenderMode(settings.renderMode);
    const image = parseInitialImageUrl(settings.initialImageUrl);
    if (health && !(mode === 'auto' ? health.anyKeyConfigured : health.falKeyConfigured)) {
      return mode === 'auto' ? 'Configure a MiniMax or fal key on the renderer server.' : 'This rendering mode requires FAL_KEY on the renderer server.';
    }
    if (mode === 'fal-turbo-i2v' && !image) return 'Turbo image to video requires an HTTPS initial scene image.';
    if (mode === 'fal-max-ref2v' && !image && !settings.characterReferences.some(reference => reference.characterName.trim() && reference.imageUrl.trim().startsWith('https://'))) {
      return 'Max reference to video requires an initial scene image or a named character image reference.';
    }
    if (!Number.isInteger(settings.generationConcurrency) || settings.generationConcurrency < 1 || settings.generationConcurrency > 8) return 'Generation concurrency must be from 1 to 8.';
    if (!Number.isInteger(settings.maxBufferedSeconds) || settings.maxBufferedSeconds < 5 || settings.maxBufferedSeconds > 120) return 'Generation lookahead must be from 5 to 120 seconds.';
    return null;
  } catch (error) { return error instanceof Error ? error.message : 'Invalid rendering options.'; }
}

export function buildShotPlannerSettings(settings: RendererSettings): ShotPlannerSettings {
  const includeReferences = settings.renderMode === 'fal-max-ref2v' || settings.useCharacterReferences;
  return {
    characters: Object.fromEntries((includeReferences ? settings.characterReferences : []).filter(reference => reference.characterName.trim()).map(reference => [reference.characterName.trim(), {
      name: reference.characterName.trim(),
      ...(reference.description?.trim() ? { description: reference.description.trim() } : {}),
      ...(reference.imageUrl.trim().startsWith('https://') ? { imageUrl: reference.imageUrl.trim() } : {}),
      ...(reference.audioUrl.trim().startsWith('https://') && reference.audioDurationSeconds !== undefined && reference.audioDurationSeconds >= 2 && reference.audioDurationSeconds <= 15
        ? { voice: { url: reference.audioUrl.trim(), durationSeconds: reference.audioDurationSeconds } } : {}),
    }])),
    initialImageUrl: settings.initialImageUrl.trim() || undefined,
    styleDescription: settings.styleDescription.trim() || undefined,
    defaultDurationSeconds: settings.duration,
    useDialogueAudioReferences: settings.renderMode !== 'fal-turbo-i2v',
  };
}

export function externalRenderOptions(settings: RendererSettings) {
  return {
    renderMode: settings.renderMode,
    initialImageUrl: settings.initialImageUrl.trim() || undefined,
    generationConcurrency: settings.generationConcurrency,
    maxBufferedSeconds: settings.maxBufferedSeconds,
    resolution: settings.resolution,
    clipDurationSeconds: settings.duration,
    shotPlanner: buildShotPlannerSettings(settings),
  };
}
