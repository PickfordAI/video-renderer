import { describe, expect, it } from 'vitest';
import { publicMediaBaseUrl } from './public-origin.js';
describe('provider origin discovery', () => {
  it('derives Fly, Render and VM stream origins without container addresses', () => {
    expect(publicMediaBaseUrl({ FLY_APP_NAME: 'my-story' })).toBe('https://my-story.fly.dev/hls');
    expect(publicMediaBaseUrl({ RENDER_EXTERNAL_URL: 'https://my-story.onrender.com' })).toBe('https://my-story.onrender.com/hls');
    expect(publicMediaBaseUrl({ PUBLIC_APP_URL: 'https://stories.example.com/' })).toBe('https://stories.example.com/hls');
  });
  it('preserves explicit overrides and local port selection', () => {
    expect(publicMediaBaseUrl({ PUBLIC_MEDIA_BASE_URL: 'https://media.example.com/custom/', FLY_APP_NAME: 'story' })).toBe('https://media.example.com/custom');
    expect(publicMediaBaseUrl({ MEDIA_PORT: '5001' })).toBe('http://127.0.0.1:5001/hls');
  });
});
