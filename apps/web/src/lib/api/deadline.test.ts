import { describe, expect, it } from 'vitest';
import { remainingSeconds } from './deadline';

describe('server deadline countdown', () => {
  const start = Date.parse('2026-10-14T08:00:00.000Z');
  const deadline = new Date(start + 300_000).toISOString();

  it('catches up after a tab was suspended instead of counting timer callbacks', () => {
    expect(remainingSeconds(deadline, 0, start)).toBe(300);
    expect(remainingSeconds(deadline, 0, start + 240_000)).toBe(60);
    expect(remainingSeconds(deadline, 0, start + 301_000)).toBe(0);
  });

  it('handles a device clock ahead of or behind the server', () => {
    expect(remainingSeconds(deadline, -120_000, start + 120_000)).toBe(300);
    expect(remainingSeconds(deadline, 120_000, start - 120_000)).toBe(300);
  });
});
