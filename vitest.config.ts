import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'scripts/**/*.test.js', 'viewer/**/*.test.js'],
    // Bridge fixtures pin the inline data-URL wire shape; fal-storage.test.ts covers the storage
    // transport explicitly with its own fetch fakes.
    env: { FAL_SCENE_ASSET_TRANSPORT: 'inline' },
  },
});
