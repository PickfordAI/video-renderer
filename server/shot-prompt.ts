import type { MinimaxSceneContext } from './scene-context.js';
import type { PlannedAudioReference, ShotImageReference } from './shot-planner.js';

/** Authored metadata only. Full scene state is retained here for visibility resolution. */
export interface ShotPromptInput {
  subjects: readonly {
    name: string;
    characterId?: string;
    present?: boolean;
    startingGaze?: string;
    startingEmotion?: string;
    gazeSource?: 'explicit-dss' | 'persistent-dss';
    emotionSource?: 'explicit-dss' | 'persistent-dss';
    visible: boolean;
    description?: string;
    appearance?: string;
    startingBlocking?: string;
    startingPosture?: string;
    resultingBlocking?: string;
    resultingPosture?: string;
    bodyOrientation?: string;
    gaze?: string;
    /** An explicitly authored camera-relative direction, when available. */
    gazeDirection?: string;
    emotion?: string;
  }[];
  /** Current group evidence; retained internally, never emitted directly as visual prose. */
  recordedSceneState?: Record<string, unknown>;
  commandEvidence?: readonly { command: string; args: Record<string, unknown> }[];
  cameraSource?: 'explicit-dss' | 'persistent-dss' | 'planner-default';
  sceneDescription?: string;
  scene: string;
  /** Setting identity, separate from scene-wide staging prose. */
  sceneName?: string;
  /** Lighting/dressing metadata that remains applicable to the selected view. */
  sceneAtmosphere?: readonly string[];
  sceneContext?: MinimaxSceneContext;
  /** Presence selects prepared coverage. Attention is resolved per visible subject. */
  preparedAttention?: string;
  styleDescription?: string;
  initialFrameOnly: boolean;
  framing: string;
  cameraCharacter?: string;
  tightShot: boolean;
  durationSeconds: number;
  actions: readonly string[];
  speech?: {
    speaker: string;
    dialogue: string;
    deliveryDirections: readonly string[];
    /** Phrase boundaries retained from DSS inline delivery tags. */
    deliveryBeats?: readonly { phrase: string; directions: readonly string[] }[];
    tone?: string;
    /** Authored addressee, independent of the resolved visual attention target. */
    respondent?: string;
    listener?: string;
  };
}

/** Select once before numbering and submission; scene-state cast is not a reference roster. */
export function selectShotPromptReferences(input: ShotPromptInput, images: readonly ShotImageReference[], audios: readonly PlannedAudioReference[]): { images: ShotImageReference[]; audios: PlannedAudioReference[] } {
  if (input.initialFrameOnly) return { images: [], audios: [] };
  const visible = new Set(input.subjects.filter(subject => subject.visible).map(subject => subject.name));
  return {
    images: images.filter(image => image.role !== 'character' || visible.has(image.name))
      .map((image, index) => ({ ...image, label: `Image ${index + 1}` })),
    audios: audios.filter(audio => audio.name === input.speech?.speaker)
      .map((audio, index) => ({ ...audio, label: `Audio ${index + 1}` })),
  };
}
