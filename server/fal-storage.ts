/**
 * One-time uploads to fal's CDN storage.
 *
 * Reference images used to travel as base64 data URLs inside every generation request, so each
 * clip re-uploaded several megabytes of PNG that fal then had to ingest before returning a
 * request id: 30–55 s of "submit" per clip against 5–10 s of actual generation. Uploading each
 * asset once and passing its fal.media URL removes that from the critical path.
 */

const STORAGE_INITIATE_URL = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';

export class FalStorageError extends Error {}

export interface FalStorageUploadOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  initiateUrl?: string;
}

export type ReferenceUploader = (bytes: Uint8Array, contentType: string, fileName: string, signal?: AbortSignal) => Promise<string>;

/** Upload bytes to fal storage and return the public file URL fal accepts as a reference. */
export async function uploadToFalStorage(
  bytes: Uint8Array,
  contentType: string,
  fileName: string,
  options: FalStorageUploadOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const initiate = await fetchImpl(options.initiateUrl ?? STORAGE_INITIATE_URL, {
    method: 'POST',
    headers: { Authorization: `Key ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    signal: options.signal,
  });
  if (!initiate.ok) throw new FalStorageError(`fal storage initiate failed (${initiate.status})`);
  const handle = (await initiate.json()) as { upload_url?: unknown; file_url?: unknown };
  if (typeof handle.upload_url !== 'string' || typeof handle.file_url !== 'string') {
    throw new FalStorageError('fal storage initiate returned no upload_url/file_url');
  }
  const put = await fetchImpl(handle.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
    signal: options.signal,
  });
  if (!put.ok) throw new FalStorageError(`fal storage upload failed (${put.status})`);
  return handle.file_url;
}

/** Bind an uploader to a key so callers that resolve assets need not know about fal. */
export function falReferenceUploader(apiKey: string, fetchImpl?: typeof fetch): ReferenceUploader {
  return (bytes, contentType, fileName, signal) => uploadToFalStorage(bytes, contentType, fileName, { apiKey, fetchImpl, signal });
}

/**
 * How resolved scene images reach the provider: `storage` uploads once and references the URL,
 * `inline` keeps the legacy base64 data URL (tests, or a provider with no storage API).
 */
export function sceneAssetTransport(env: NodeJS.ProcessEnv = process.env): 'storage' | 'inline' {
  return env.FAL_SCENE_ASSET_TRANSPORT === 'inline' ? 'inline' : 'storage';
}

/** Upload an inline data URL (as produced by frame extraction) and return the storage URL. */
export async function uploadDataUrl(dataUrl: string, fileName: string, uploader: ReferenceUploader, signal?: AbortSignal): Promise<string> {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new FalStorageError('continuity frame is not a base64 data URL');
  return uploader(new Uint8Array(Buffer.from(match[2], 'base64')), match[1], fileName, signal);
}
