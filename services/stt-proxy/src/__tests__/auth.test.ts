import { describe, expect, it } from 'vitest';
import { isEmailAllowed } from '../auth.js';

describe('isEmailAllowed', () => {
  it('allows any email when ALLOWED_EMAILS is empty or unset', () => {
    expect(isEmailAllowed('anyone@gmail.com', '')).toBe(true);
    expect(isEmailAllowed('anyone@gmail.com', undefined)).toBe(true);
    expect(isEmailAllowed(undefined, '')).toBe(true);
  });

  it('matches case-insensitively with comma or semicolon separators', () => {
    const allowlist = 'Alice@Example.com; bob@example.com, carol@example.com';
    expect(isEmailAllowed('alice@example.com', allowlist)).toBe(true);
    expect(isEmailAllowed('BOB@EXAMPLE.COM', allowlist)).toBe(true);
    expect(isEmailAllowed('carol@example.com', allowlist)).toBe(true);
    expect(isEmailAllowed('stranger@gmail.com', allowlist)).toBe(false);
    expect(isEmailAllowed(undefined, allowlist)).toBe(false);
  });
});
