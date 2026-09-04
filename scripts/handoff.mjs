const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateHandoff(value, hosted = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Handoff must be a JSON object.');
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
