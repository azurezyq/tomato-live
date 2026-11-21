import { describe, expect, it } from 'vitest';
import { DailyTurnLimiter } from '../rateLimit.js';

describe('DailyTurnLimiter', () => {
  it('defaults to 1000 when MAX_DAILY_TURNS is unset', () => {
    expect(DailyTurnLimiter.parseLimit(undefined)).toBe(1000);
    expect(DailyTurnLimiter.parseLimit('')).toBe(1000);
    expect(DailyTurnLimiter.parseLimit('0')).toBe(0);
    expect(DailyTurnLimiter.parseLimit('250')).toBe(250);
  });

  it('allows up to the daily limit and blocks once reached', () => {
    const limiter = new DailyTurnLimiter(() => new Date('2026-11-21T05:00:00Z'));
    expect(limiter.consumeTurn(2)).toEqual({
      allowed: true,
      used: 1,
      limit: 2,
      date: '2026-11-21',
    });
    expect(limiter.consumeTurn(2)).toEqual({
      allowed: true,
      used: 2,
      limit: 2,
      date: '2026-11-21',
    });
    expect(limiter.isLimitReached(2)).toBe(true);
    expect(limiter.consumeTurn(2)).toEqual({
      allowed: false,
      used: 2,
      limit: 2,
      date: '2026-11-21',
    });
  });

  it('resets automatically when the UTC date advances', () => {
    let now = new Date('2026-11-21T23:59:59Z');
    const limiter = new DailyTurnLimiter(() => now);
    expect(limiter.consumeTurn(1).allowed).toBe(true);
    expect(limiter.isLimitReached(1)).toBe(true);

    now = new Date('2026-11-22T00:00:01Z');
    expect(limiter.isLimitReached(1)).toBe(false);
    expect(limiter.consumeTurn(1)).toEqual({
      allowed: true,
      used: 1,
      limit: 1,
      date: '2026-11-22',
    });
  });

  it('disables the limit when set to 0', () => {
    const limiter = new DailyTurnLimiter(() => new Date('2026-11-21T05:00:00Z'));
    expect(limiter.isLimitReached(0)).toBe(false);
    expect(limiter.consumeTurn(0).allowed).toBe(true);
    expect(limiter.isLimitReached(0)).toBe(false);
  });
});
