import { execFileSync } from 'node:child_process';
import { services, rendererOrigin } from './config.mjs';
const checks = [];
const falCheck = { name: 'fal credential (environment or running worker)', ok: Boolean(process.env.FAL_KEY || process.env.FAL_API_KEY) };
const major = Number(process.versions.node.split('.')[0]);
checks.push({ name: 'Node.js 22+', ok: major >= 22 });
checks.push(falCheck);
try { execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }); checks.push({ name: 'FFmpeg', ok: true }); }
catch { checks.push({ name: 'FFmpeg', ok: false, fix: 'Install FFmpeg or use the full Docker profile.' }); }
for (const [name, url] of Object.entries({ ...services(), worker: rendererOrigin, mediaRelay: process.env.MEDIA_RELAY_HLS_BASE_URL || 'http://127.0.0.1:8888' })) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (name === 'worker' && response.ok) {
      const health = await response.json();
      falCheck.ok ||= health.falKeyConfigured === true;
    } else await response.body?.cancel();
    // A 404 still proves the HTTP service is reachable; it is not protocol/auth verification.
    checks.push({ name, ok: response.status < 500, status: response.status, check: 'HTTP reachability' });
  } catch { checks.push({ name, ok: false, fix: `Start ${name}; run npm run setup after changing the Docker stack.` }); }
}
for (const key of ['narrativeEngineUrl', 'rendererBaseUrl']) if (!services()[key]) checks.push({ name: key, ok: false, fix: 'Run npm run setup.' });
console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks }, null, 2));
process.exitCode = checks.every(c => c.ok) ? 0 : 1;
