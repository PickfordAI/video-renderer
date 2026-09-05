import { option, readState, sessionFile } from './config.mjs';
import { watchUrlForStream } from './watch-url.mjs';
try {
  const session = readState(sessionFile);
  console.log(JSON.stringify({ watchUrl: watchUrlForStream(session?.hlsUrl, option('viewer')), access: 'Anyone with this link can watch while the story is running.' }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
