import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatSessionReset } from '@/modules/usage/ClaudeSessionUsage';

test('the reset countdown reads as hours and minutes, minutes alone, or nothing', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  assert.equal(formatSessionReset('2026-10-26T12:13:00Z', now), '2h 13m');
  assert.equal(formatSessionReset('2026-10-26T11:05:00Z', now), '1h 05m');
  assert.equal(formatSessionReset('2026-10-26T10:45:00Z', now), '45m');
  assert.equal(formatSessionReset('2026-10-26T10:00:20Z', now), '1m', 'a part minute rounds up');
  assert.equal(formatSessionReset('2026-10-26T09:00:00Z', now), null, 'already reset');
  assert.equal(formatSessionReset(null, now), null);
  assert.equal(formatSessionReset('not a date', now), null);
});
