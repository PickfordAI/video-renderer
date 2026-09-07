/** Per-request ceiling for one provider job, shared by the fal and direct MiniMax adapters. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MINIMUM_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Under account-level queueing a clip can legitimately wait several minutes, and a timeout
 * here fences the whole run, so operators may raise it with FAL_REQUEST_TIMEOUT_MS.
 */
export function defaultRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.FAL_REQUEST_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed >= MINIMUM_REQUEST_TIMEOUT_MS ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}
