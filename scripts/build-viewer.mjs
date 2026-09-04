import { build } from 'vite';
import { copyFile, mkdir } from 'node:fs/promises';
await build({ configFile: false, base: './', root: 'viewer', publicDir: false, build: { outDir: '../viewer-dist', emptyOutDir: true } });

await mkdir('viewer-dist/licenses', { recursive: true });
await copyFile('node_modules/hls.js/LICENSE', 'viewer-dist/licenses/hls.js.txt');
await copyFile('LICENSE', 'viewer-dist/licenses/renderer.txt');
