import { cp, rm } from 'node:fs/promises';
// Remove retired application assets, including builds left from the old studio.
await rm('dist', { recursive: true, force: true });
await cp('viewer-dist', 'dist/viewer', { recursive: true });
