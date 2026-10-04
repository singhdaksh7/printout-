import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_MINUTES, retentionHyphen, retentionPhrase } from './retention';

describe('retention wording', () => {
  it('follows the server value', () => {
    expect(retentionPhrase(30)).toBe('30 minutes');
    expect(retentionPhrase(1)).toBe('1 minute');
    expect(retentionPhrase(45)).toBe('45 minutes');
    expect(retentionHyphen(1)).toBe('1-minute');
    expect(retentionHyphen(45)).toBe('45-minute');
  });
  it('falls back to 30 (display only) when the server value is absent or invalid', () => {
    expect(DEFAULT_RETENTION_MINUTES).toBe(30);
    for (const v of [undefined, null, 0, -5, NaN]) {
      expect(retentionPhrase(v)).toBe('30 minutes');
      expect(retentionHyphen(v)).toBe('30-minute');
    }
  });
});
