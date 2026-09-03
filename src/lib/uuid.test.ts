import { describe, expect, it } from 'vitest';

import { isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts service UUIDs and rejects renderer-only episode labels', () => {
    expect(isUuid('c7dfcb7c-5908-48bc-851c-f39f67a04ac4')).toBe(true);
    expect(isUuid('episode-0')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
