/** Versioned wire contract shared with StoryKernel's certified scene context. */
export interface PreparedView {
  assetId: string;
  imageUrl: string;
  contentSha256: string;
  visibleCharacterIds: readonly string[];
}
export interface PreparedCoverage {
  version: 1;
  preparationId: string;
  sourceFingerprint: string;
  master: PreparedView;
  closeups: Readonly<Record<string, PreparedView>>;
  bodyOrientations: Readonly<Record<string, string>>;
  characterContentSha256: Readonly<Record<string, string>>;
  /** Set only after all original portrait and composition bytes have passed hash checks. */
  verified?: true;
}
const record = (v: unknown, label: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be an object`);
  return v as Record<string, unknown>;
};
const string = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} must be a nonblank string`);
  return v;
};
function uuid(v: unknown): string {
  const s = string(v, 'prepared coverage ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) throw new Error('Prepared coverage ID must be a UUID');
  return s.toLowerCase();
}
function sha(v: unknown): string {
  const s = string(v, 'prepared coverage content hash');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('Prepared coverage hash must be lowercase SHA256');
  return s;
}
function exactKeys(v: unknown, cast: readonly string[], label: string): Record<string, unknown> {
  const r = record(v, label);
  if (Object.keys(r).length !== cast.length || cast.some(id => !Object.hasOwn(r, id))) throw new Error(`${label} must exactly cover scene cast`);
  return r;
}
function view(v: unknown, visible: readonly string[]): PreparedView {
  const r = record(v, 'prepared view');
  if (!Array.isArray(r.visible_character_ids)) throw new Error('Prepared view visible_character_ids must be an array');
  const ids = r.visible_character_ids.map(uuid);
  if (ids.length !== visible.length || new Set(ids).size !== ids.length || visible.some(id => !ids.includes(id))) throw new Error('Prepared view visibility must exactly match its coverage');
  const imageUrl = string(r.image_url, 'prepared view image_url');
  const url = new URL(imageUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Prepared view image_url must be HTTPS without credentials');
  return Object.freeze({ assetId: uuid(r.asset_id), imageUrl, contentSha256: sha(r.content_sha256), visibleCharacterIds: Object.freeze(ids) });
}
export function parsePreparedCoverage(v: unknown, cast: readonly string[], originalAssetIds: readonly string[]): PreparedCoverage {
  const r = record(v, 'prepared_coverage');
  if (r.version !== 1) throw new Error('Unsupported prepared_coverage version');
  const master = view(r.master, cast);
  const closeups = Object.fromEntries(Object.entries(exactKeys(r.closeups, cast, 'prepared closeups')).map(([id, item]) => [id, view(item, [id])]));
  const bodyOrientations = Object.fromEntries(Object.entries(exactKeys(r.body_orientations, cast, 'body_orientations')).map(([id, value]) => [id, string(value, 'body orientation')]));
  const characterContentSha256 = Object.fromEntries(Object.entries(exactKeys(r.character_content_sha256, cast, 'character_content_sha256')).map(([id, value]) => [id, sha(value)]));
  const assets = [...originalAssetIds, master.assetId, ...Object.values(closeups).map(item => item.assetId)];
  if (new Set(assets).size !== assets.length) throw new Error('Prepared and original asset IDs must be unique');
  return Object.freeze({ version: 1, preparationId: uuid(r.preparation_id), sourceFingerprint: sha(r.source_fingerprint), master, closeups: Object.freeze(closeups), bodyOrientations: Object.freeze(bodyOrientations), characterContentSha256: Object.freeze(characterContentSha256) });
}
/** Signed URL refresh does not change immutable preparation identity. */
export function preparedCoverageIdentity(coverage: PreparedCoverage): string {
  const stableView = (v: PreparedView) => [v.assetId, v.contentSha256, v.visibleCharacterIds];
  return JSON.stringify([coverage.preparationId, coverage.sourceFingerprint, stableView(coverage.master), Object.entries(coverage.closeups).sort().map(([id, v]) => [id, stableView(v)]), Object.entries(coverage.bodyOrientations).sort(), Object.entries(coverage.characterContentSha256).sort()]);
}
