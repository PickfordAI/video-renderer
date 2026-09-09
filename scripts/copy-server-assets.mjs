#!/usr/bin/env node
// PIC-1832: tsc compiles only TypeScript, so data files the server reads at runtime
// (the WhispMax bible) have to be copied into the build output alongside it.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ASSETS = ['whispmax/bible.json'];
const root = join(import.meta.dirname, '..');

for (const asset of ASSETS) {
  const destination = join(root, 'server-dist', asset);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, 'server', asset), destination);
  process.stdout.write(`copied ${asset}\n`);
}
