export function publicMediaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PUBLIC_MEDIA_BASE_URL) return env.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, '');
  const origin = env.PUBLIC_APP_URL || env.RENDER_EXTERNAL_URL || (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : undefined);
  if (origin) return `${origin.replace(/\/$/, '')}/hls`;
  return `http://127.0.0.1:${env.MEDIA_PORT ?? '4174'}/hls`;
}
