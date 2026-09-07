function httpsMedia(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be an HTTPS URL.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${field} must be an HTTPS URL without credentials.`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
}

/** Plain Node CLI mirror; conformance tests compare this with the shared server schema. */
export function handoffRendererConfig(value) {
  if (value.rendererConfig !== undefined) object(value.rendererConfig, 'rendererConfig');
  const config = value.rendererConfig ?? {};
  const model = config.model ?? value.renderMode ?? 'auto';
  const supported = { auto: ['none'], 'fal-turbo-i2v': ['last-frame-chain'], 'fal-max-ref2v': ['none', 'camera-anchors'] };
  if (!Object.hasOwn(supported, model)) throw new Error('rendererConfig.model must be auto, fal-turbo-i2v, or fal-max-ref2v.');
  const continuity = config.continuity ?? (model === 'fal-turbo-i2v' ? 'last-frame-chain' : model === 'fal-max-ref2v' ? 'camera-anchors' : 'none');
  if (!supported[model].includes(continuity)) throw new Error(`${model} does not yet support the ${continuity} continuity strategy`);
  const concurrency = config.concurrency ?? value.generationConcurrency ?? 2;
  const maxBufferedSeconds = config.maxBufferedSeconds ?? value.maxBufferedSeconds ?? 30;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('rendererConfig.concurrency must be an integer from 1 to 32.');
  if (!Number.isInteger(maxBufferedSeconds) || maxBufferedSeconds < 5 || maxBufferedSeconds > 150) throw new Error('rendererConfig.maxBufferedSeconds must be an integer from 5 to 150.');
  return { model, continuity, concurrency, maxBufferedSeconds };
}

export function renderingOptions(value) {
  const rendererConfig = handoffRendererConfig(value);
  const renderMode = rendererConfig.model;
  const planner = value.shotPlanner;
  if (planner !== undefined) {
    object(planner, 'shotPlanner');
    if (planner.initialImageUrl !== undefined) httpsMedia(planner.initialImageUrl, 'shotPlanner.initialImageUrl');
    if (planner.styleImageUrl !== undefined) httpsMedia(planner.styleImageUrl, 'shotPlanner.styleImageUrl');
    if (planner.styleDescription !== undefined && typeof planner.styleDescription !== 'string') throw new Error('shotPlanner.styleDescription must be text.');
    for (const field of ['characters', 'sets']) if (planner[field] !== undefined) {
      object(planner[field], `shotPlanner.${field}`);
      for (const [name, item] of Object.entries(planner[field])) {
        if (!name.trim()) throw new Error(`shotPlanner.${field} requires named entries.`);
        object(item, `shotPlanner.${field}.${name}`);
        if (item.imageUrl !== undefined) httpsMedia(item.imageUrl, `shotPlanner.${field}.${name}.imageUrl`);
        if (item.voice !== undefined) {
          object(item.voice, `shotPlanner.${field}.${name}.voice`);
          httpsMedia(item.voice.url, `shotPlanner.${field}.${name}.voice.url`);
          if (!Number.isFinite(item.voice.durationSeconds) || item.voice.durationSeconds < 2 || item.voice.durationSeconds > 15) throw new Error('Voice sample durationSeconds must be from 2 to 15.');
        }
      }
    }
  }
  const initialImageUrl = value.initialImageUrl || planner?.initialImageUrl;
  if (initialImageUrl !== undefined) httpsMedia(initialImageUrl, 'initialImageUrl');
  if (renderMode === 'fal-turbo-i2v' && !initialImageUrl) throw new Error('Turbo requires an initialImageUrl.');
  // Max can receive image references later in Kernel scene_context. The bridge
  // validates every visual shot before submitting it to a provider.
  return { rendererConfig, initialImageUrl, shotPlanner: planner };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateHandoff(value, hosted = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Handoff must be a JSON object.');
  renderingOptions(value);
  for (const field of ['rendererId', 'credentialId', 'evdId']) if (typeof value[field] !== 'string' || !uuid.test(value[field])) throw new Error(`Handoff ${field} must be a UUID supplied by Story Kernel.`);
  if (typeof value.clientSecret !== 'string' || !value.clientSecret.trim()) throw new Error('Handoff clientSecret is required.');
  if (value.startMode !== undefined && !['legacy', 'opaque'].includes(value.startMode)) throw new Error('startMode must be legacy or opaque.');
  if (value.setupToken !== undefined && (typeof value.setupToken !== 'string' || !value.setupToken.trim())) throw new Error('setupToken must be non-empty text when supplied.');
  if (value.startMode !== 'opaque' && !value.story && !value.setupToken) throw new Error('Provide setupToken or an already-provisioned story.');
  if (value.storyType !== undefined && !['CREATOR', 'WHISPERS', 'MINIMAX'].includes(value.storyType)) throw new Error('storyType must be CREATOR, WHISPERS, or MINIMAX.');
  if (value.environment && !['local', 'test', 'dev', 'edge', 'staging', 'creator', 'prod', 'demo'].includes(value.environment)) throw new Error('Unknown Story Kernel environment.');
  if (value.rendererVersion && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){3}$/.test(value.rendererVersion)) throw new Error('rendererVersion must have four dot-separated components.');
  if (value.resolution && !['480P', '768P'].includes(value.resolution)) throw new Error('resolution must be 480P or 768P.');
  if (value.clipDurationSeconds !== undefined && (!Number.isInteger(value.clipDurationSeconds) || value.clipDurationSeconds < 5 || value.clipDurationSeconds > 15)) throw new Error('clipDurationSeconds must be an integer from 5 to 15.');
  if (value.storyConfig !== undefined && (!value.storyConfig || typeof value.storyConfig !== 'object' || Array.isArray(value.storyConfig))) throw new Error('storyConfig must be an object.');
  if (value.storyConfig?.base_structure !== undefined && value.storyConfig.base_structure !== (value.storyType ?? 'CREATOR')) throw new Error('storyConfig.base_structure must match storyType (CREATOR when omitted).');
  for (const [name, url] of Object.entries(value.services ?? {})) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Handoff contains an invalid service URL.'); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Service URLs cannot contain credentials, queries, or fragments.');
    const local = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    // The renderer bridge is a WebSocket endpoint; every other service is HTTP.
    const secure = name === 'rendererWebsocketUrl' ? 'wss:' : 'https:';
    const plain = name === 'rendererWebsocketUrl' ? 'ws:' : 'http:';
    if (parsed.protocol !== secure && !(parsed.protocol === plain && local && !hosted)) {
      throw new Error(name === 'rendererWebsocketUrl'
        ? 'rendererWebsocketUrl must use WSS; local mode also permits loopback WS.'
        : 'Services must use HTTPS; local mode also permits loopback HTTP.');
    }
    if (hosted && local) throw new Error('Hosted workers cannot reach local Docker services.');
  }
  if (value.story) {
    for (const key of ['roomId', 'storyMessageChannelId', 'roomMainMessageChannelId']) if (!uuid.test(value.story[key] ?? '')) throw new Error(`story.${key} must be a UUID.`);
    if (!Number.isSafeInteger(value.story.storyId) || value.story.storyId <= 0 || !value.story.roomShortlink) throw new Error('Existing story requires storyId and roomShortlink.');
    if (value.story.storyMessageChannelId === value.story.roomMainMessageChannelId) throw new Error('Room-main and story channels must be distinct.');
  }
  return value;
}
