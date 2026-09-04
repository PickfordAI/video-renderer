function httpsMedia(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be an HTTPS URL.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${field} must be an HTTPS URL without credentials.`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
}

export function renderingOptions(value) {
  const renderMode = value.renderMode ?? 'auto';
  if (!['auto', 'fal-turbo-i2v', 'fal-max-ref2v'].includes(renderMode)) throw new Error('renderMode must be auto, fal-turbo-i2v, or fal-max-ref2v.');
  const generationConcurrency = value.generationConcurrency ?? 2;
  const maxBufferedSeconds = value.maxBufferedSeconds ?? 30;
  if (!Number.isInteger(generationConcurrency) || generationConcurrency < 1 || generationConcurrency > 8) throw new Error('generationConcurrency must be an integer from 1 to 8.');
  if (!Number.isInteger(maxBufferedSeconds) || maxBufferedSeconds < 5 || maxBufferedSeconds > 120) throw new Error('maxBufferedSeconds must be an integer from 5 to 120.');
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
  const hasReferenceImage = initialImageUrl || planner?.styleImageUrl || [planner?.characters, planner?.sets].some(entries => Object.values(entries ?? {}).some(item => item.imageUrl));
  if (renderMode === 'fal-max-ref2v' && !hasReferenceImage) throw new Error('Max ref2vid requires an initial image or shotPlanner image references.');
  return { renderMode, initialImageUrl, generationConcurrency, maxBufferedSeconds, shotPlanner: planner };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateHandoff(value, hosted = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Handoff must be a JSON object.');
  renderingOptions(value);
  for (const field of ['rendererId', 'credentialId', 'evdId']) if (typeof value[field] !== 'string' || !uuid.test(value[field])) throw new Error(`Handoff ${field} must be a UUID supplied by Story Kernel.`);
  if (typeof value.clientSecret !== 'string' || !value.clientSecret.trim()) throw new Error('Handoff clientSecret is required.');
  if (!value.story && (typeof value.setupToken !== 'string' || !value.setupToken.trim())) throw new Error('Provide setupToken or an already-provisioned story.');
  if (value.storyType && !['CREATOR', 'WHISPERS'].includes(value.storyType)) throw new Error('storyType must be CREATOR or WHISPERS.');
  if (value.environment && !['local', 'test', 'dev', 'edge', 'staging', 'creator', 'prod', 'demo'].includes(value.environment)) throw new Error('Unknown Story Kernel environment.');
  if (value.rendererVersion && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){3}$/.test(value.rendererVersion)) throw new Error('rendererVersion must have four dot-separated components.');
  if (value.resolution && !['480P', '768P'].includes(value.resolution)) throw new Error('resolution must be 480P or 768P.');
  if (value.clipDurationSeconds !== undefined && (!Number.isInteger(value.clipDurationSeconds) || value.clipDurationSeconds < 5 || value.clipDurationSeconds > 15)) throw new Error('clipDurationSeconds must be an integer from 5 to 15.');
  if (value.storyConfig !== undefined && (!value.storyConfig || typeof value.storyConfig !== 'object' || Array.isArray(value.storyConfig))) throw new Error('storyConfig must be an object.');
  for (const url of Object.values(value.services ?? {})) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Handoff contains an invalid service URL.'); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Service URLs cannot contain credentials, queries, or fragments.');
    const local = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local && !hosted)) throw new Error('Services must use HTTPS; local mode also permits loopback HTTP.');
    if (hosted && local) throw new Error('Hosted workers cannot reach local Docker services.');
  }
  if (value.story) {
    for (const key of ['roomId', 'storyMessageChannelId', 'roomMainMessageChannelId']) if (!uuid.test(value.story[key] ?? '')) throw new Error(`story.${key} must be a UUID.`);
    if (!Number.isSafeInteger(value.story.storyId) || value.story.storyId <= 0 || !value.story.roomShortlink) throw new Error('Existing story requires storyId and roomShortlink.');
    if (value.story.storyMessageChannelId === value.story.roomMainMessageChannelId) throw new Error('Room-main and story channels must be distinct.');
  }
  return value;
}
