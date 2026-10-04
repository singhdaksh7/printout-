import { describe, expect, it } from 'vitest';
import { parsePageRanges } from '../../lib/customer-pages';
import { buildOptions, initialConfig } from '../config';

describe('parsePageRanges', () => {
  it('parses a single page', () => {
    expect(parsePageRanges('3', 10)).toEqual({ ok: true, ranges: [{ from: 3, to: 3 }] });
  });
  it('parses 1-5', () => {
    expect(parsePageRanges('1-5', 10)).toEqual({ ok: true, ranges: [{ from: 1, to: 5 }] });
  });
  it('parses 1-5,8,10-12 with spaces', () => {
    expect(parsePageRanges(' 1-5, 8 ,10-12 ', 12)).toEqual({ ok: true, ranges: [{ from: 1, to: 5 }, { from: 8, to: 8 }, { from: 10, to: 12 }] });
  });
  it('rejects reversed ranges', () => {
    const r = parsePageRanges('5-1', 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/backwards/);
  });
  it('rejects out of range pages against the page count', () => {
    const r = parsePageRanges('1-11', 10);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/10 pages/);
  });
  it('rejects page zero', () => {
    expect(parsePageRanges('0-3', 10).ok).toBe(false);
  });
  it.each(['', '   ', 'abc', '1--3', '1-', '-3', ',1', '1,', '1,,2', '1.5', '1-2-3', '١'])('rejects malformed %j', (s) => {
    expect(parsePageRanges(s, 10).ok).toBe(false);
  });
  it('rejects absurd lengths and counts', () => {
    expect(parsePageRanges('1,'.repeat(150) + '1', 500).ok).toBe(false);
    expect(parsePageRanges(Array.from({ length: 60 }, (_, i) => i + 1).join(','), 500).ok).toBe(false);
    expect(parsePageRanges('1-9999999', 500).ok).toBe(false);
  });
});

describe('buildOptions', () => {
  it('builds an all-pages payload', () => {
    const b = buildOptions({ ...initialConfig, copies: '3', sides: 'duplex' }, 5);
    expect(b.options).toEqual({ paperSize: 'A4', colourMode: 'bw', sides: 'duplex', copies: 3, pageSelection: { mode: 'all' } });
  });
  it('builds a ranges payload', () => {
    const b = buildOptions({ ...initialConfig, pageMode: 'custom', pageText: '1-5,8,10-12' }, 12);
    expect(b.options?.pageSelection).toEqual({ mode: 'ranges', ranges: [{ from: 1, to: 5 }, { from: 8, to: 8 }, { from: 10, to: 12 }] });
  });
  it.each(['0', '1001', '', 'x', '1.5'])('rejects copies %j', (c) => {
    const b = buildOptions({ ...initialConfig, copies: c }, 5);
    expect(b.options).toBeNull();
    expect(b.copiesError).toBeTruthy();
  });
  it('accepts the 1 and 1000 bounds', () => {
    expect(buildOptions({ ...initialConfig, copies: '1' }, 5).options).not.toBeNull();
    expect(buildOptions({ ...initialConfig, copies: '1000' }, 5).options).not.toBeNull();
  });
});
