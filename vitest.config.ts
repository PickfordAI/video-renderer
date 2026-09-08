import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'scripts/**/*.test.js', 'viewer/**/*.test.js'],
    // Bridge fixtures pin the inline data-URL wire shape; fal-storage.test.ts covers the storage
    // transport explicitly with its own fetch fakes.
    // Bridge fixtures also pin one-clip startup and strict anchor dependencies; the startup
    // independence policy has its own unit test in shot-generation-startup.test.ts.
    env: { FAL_SCENE_ASSET_TRANSPORT: 'inline', RENDERER_STARTUP_BUFFER_CLIPS: '1', RENDERER_INDEPENDENT_STARTUP_SHOTS: '0' },
  },
});
