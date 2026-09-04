import { cp, copyFile, mkdir } from 'node:fs/promises';
await cp('viewer-dist', 'dist/viewer', { recursive: true });

await mkdir('dist/licenses', { recursive: true });
for (const name of ['hls.js', 'react', 'react-dom']) await copyFile(`node_modules/${name}/LICENSE`, `dist/licenses/${name}.txt`);
