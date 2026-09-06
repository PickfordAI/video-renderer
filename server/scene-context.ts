type JsonObject = Record<string, unknown>;

export interface MinimaxSceneImage {
  assetId: string;
  sourceId: string;
  characterName?: string;
  imageUrl: string;
}

export interface MinimaxSceneContext {
  setImage: MinimaxSceneImage;
  characterImages: ReadonlyArray<MinimaxSceneImage>;
  characterPositions: Readonly<Record<string, string>>;
}

interface CachedSceneImage {
  sourceId: string;
  characterName?: string;
  dataUrl: string;
}

const MAX_SCENE_IMAGE_BYTES = 20 * 1024 * 1024;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function uuid(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new Error(`${label} must be a UUID`);
  }
  return result.toLowerCase();
}

function https(value: unknown, label: string): string {
  const result = text(value, label);
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new Error(`${label} must be an absolute HTTPS URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials`);
  }
  return result;
}

function image(value: unknown, label: string, sourceField: 'set_id' | 'character_id'): MinimaxSceneImage {
  const raw = object(value, label);
  return {
    assetId: uuid(raw.asset_id, `${label}.asset_id`),
    sourceId: sourceField === 'character_id'
      ? uuid(raw[sourceField], `${label}.${sourceField}`)
      : text(raw[sourceField], `${label}.${sourceField}`),
    ...(sourceField === 'character_id'
      ? { characterName: exactText(raw.character_name, `${label}.character_name`) }
      : {}),
    imageUrl: https(raw.image_url, `${label}.image_url`),
  };
}

export function parseMinimaxSceneContext(value: unknown): MinimaxSceneContext {
  const raw = object(value, 'scene_context');
  const setImage = image(raw.set_image, 'scene_context.set_image', 'set_id');
  if (!Array.isArray(raw.character_images) || raw.character_images.length === 0) {
    throw new Error('scene_context.character_images must be a non-empty array');
  }
  const characterImages = raw.character_images.map((item, index) =>
    image(item, `scene_context.character_images[${index}]`, 'character_id'));
  const positionsRaw = object(raw.character_positions, 'scene_context.character_positions');
  const characterPositions = Object.fromEntries(Object.entries(positionsRaw).map(([characterId, position]) => [
    uuid(characterId, 'scene_context.character_positions character ID'),
    text(position, `scene_context.character_positions.${characterId}`),
  ]));
  const characterIds = characterImages.map(item => item.sourceId);
  if (new Set(characterIds).size !== characterIds.length) throw new Error('scene_context character IDs must be unique');
  const characterNames = characterImages.map(item => item.characterName!);
  if (new Set(characterNames).size !== characterNames.length) throw new Error('scene_context character names must be unique');
  const assetIds = [setImage.assetId, ...characterImages.map(item => item.assetId)];
  if (new Set(assetIds).size !== assetIds.length) throw new Error('scene_context asset IDs must be unique');
  if (characterIds.length !== Object.keys(characterPositions).length
    || characterIds.some(characterId => !Object.hasOwn(characterPositions, characterId))) {
    throw new Error('scene_context character_positions must exactly cover character_images');
  }
  return Object.freeze({
    setImage: Object.freeze(setImage),
    characterImages: Object.freeze(characterImages.map(item => Object.freeze(item))),
    characterPositions: Object.freeze(characterPositions),
  });
}

export function sceneContextImageUrls(context: MinimaxSceneContext): string[] {
  return [...context.characterImages.map(image => image.imageUrl), context.setImage.imageUrl];
}

export function sceneContextPrompt(context: MinimaxSceneContext): string {
  const positions = context.characterImages.map((image, index) =>
    `Character reference Image ${index + 1} is ${image.characterName} (${image.sourceId}) and remains ${context.characterPositions[image.sourceId]} throughout the shot.`);
  return [
    ...positions,
    `The final reference image is the complete environment for authored set ${context.setImage.sourceId}; preserve its design and include no additional characters.`,
  ].join(' ');
}

/**
 * Fetches certified HTTPS assets once and keys successful results by immutable
 * asset identity. Refreshed access URLs therefore cannot replace an image that
 * has already been accepted for this renderer run.
 */
export class MinimaxSceneAssetCache {
  private readonly assets = new Map<string, Promise<CachedSceneImage>>();

  private async download(image: MinimaxSceneImage, signal?: AbortSignal): Promise<CachedSceneImage> {
    const response = await fetch(image.imageUrl, { signal });
    if (!response.ok) throw new Error(`Certified scene image download failed with HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!contentType?.startsWith('image/')) throw new Error('Certified scene image response must have an image content type');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SCENE_IMAGE_BYTES) {
      throw new Error('Certified scene image exceeds the renderer size limit');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error('Certified scene image response is empty');
    if (bytes.byteLength > MAX_SCENE_IMAGE_BYTES) throw new Error('Certified scene image exceeds the renderer size limit');
    return {
      sourceId: image.sourceId,
      ...(image.characterName === undefined ? {} : { characterName: image.characterName }),
      dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`,
    };
  }

  private async resolveImage(image: MinimaxSceneImage, signal?: AbortSignal): Promise<MinimaxSceneImage> {
    let pending = this.assets.get(image.assetId);
    if (!pending) {
      pending = this.download(image, signal);
      this.assets.set(image.assetId, pending);
      void pending.catch(() => {
        if (this.assets.get(image.assetId) === pending) this.assets.delete(image.assetId);
      });
    }
    const cached = await pending;
    if (cached.sourceId !== image.sourceId || cached.characterName !== image.characterName) {
      throw new Error('Certified image asset identity changed');
    }
    return Object.freeze({ ...image, imageUrl: cached.dataUrl });
  }

  async resolve(context: MinimaxSceneContext, signal?: AbortSignal): Promise<MinimaxSceneContext> {
    const [setImage, ...characterImages] = await Promise.all([
      this.resolveImage(context.setImage, signal),
      ...context.characterImages.map(image => this.resolveImage(image, signal)),
    ]);
    return Object.freeze({
      setImage,
      characterImages: Object.freeze(characterImages),
      characterPositions: context.characterPositions,
    });
  }
}
