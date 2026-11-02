import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeNextRun,
  isPingDue,
  parseConfigInput,
} from '@/modules/session-warmup/services/session-warmup.service.js';
import type { SessionWarmupConfig } from '@/modules/session-warmup/services/session-warmup.service.js';

const weekdays: SessionWarmupConfig = {
  enabled: true,
  days: [1, 2, 3, 4, 5],
  time: '07:00',
  timeZone: 'Europe/Paris',
  model: 'sonnet',
};

test('computeNextRun lands on 7:00 Paris time, in winter (UTC+1) and summer (UTC+2)', () => {
  // Mon 2 Nov 2026, 09:00 UTC is already past 7:00 Paris, so the next slot is Tuesday.
  assert.equal(computeNextRun(weekdays, new Date('2026-11-02T09:00:00Z'))?.toISOString(), '2026-11-03T06:00:00.000Z');
  assert.equal(computeNextRun(weekdays, new Date('2026-07-06T09:00:00Z'))?.toISOString(), '2026-07-07T05:00:00.000Z');
});

test('computeNextRun skips the weekend and honours a disabled schedule', () => {
  // Friday after the slot -> Monday.
  assert.equal(computeNextRun(weekdays, new Date('2026-11-06T09:00:00Z'))?.toISOString(), '2026-11-09T06:00:00.000Z');
  assert.equal(computeNextRun({ ...weekdays, enabled: false }, new Date('2026-11-02T00:00:00Z')), null);
  assert.equal(computeNextRun({ ...weekdays, days: [] }, new Date('2026-11-02T00:00:00Z')), null);
});

test('isPingDue fires once per day inside the catch-up window', () => {
  const slot = new Date('2026-11-03T06:00:00Z'); // Tuesday 07:00 Paris
  assert.equal(isPingDue(weekdays, null, new Date(slot.getTime() - 60_000)), false);
  assert.equal(isPingDue(weekdays, null, slot), true);
  assert.equal(isPingDue(weekdays, null, new Date(slot.getTime() + 60 * 60_000)), true);
  // Server came back too late to line the window up usefully.
  assert.equal(isPingDue(weekdays, null, new Date(slot.getTime() + 3 * 60 * 60_000)), false);
  // Already handled today.
  assert.equal(isPingDue(weekdays, '2026-11-03', slot), false);
});

test('isPingDue ignores weekends and a disabled schedule', () => {
  const saturday = new Date('2026-11-07T06:00:00Z');
  assert.equal(isPingDue(weekdays, null, saturday), false);
  assert.equal(isPingDue({ ...weekdays, enabled: false }, null, new Date('2026-11-03T06:00:00Z')), false);
});

test('parseConfigInput normalises days and rejects bad input', () => {
  assert.deepEqual(parseConfigInput({ ...weekdays, days: [5, 1, 1, 3] }).days, [1, 3, 5]);
  assert.throws(() => parseConfigInput({ ...weekdays, time: '7am' }), /time must look like/);
  assert.throws(() => parseConfigInput({ ...weekdays, timeZone: 'Mars/Base' }), /IANA zone/);
  assert.throws(() => parseConfigInput({ ...weekdays, model: 'opus' }), /sonnet or haiku/);
  assert.throws(() => parseConfigInput({ ...weekdays, days: [0] }), /weekday numbers/);
  assert.throws(() => parseConfigInput({ ...weekdays, enabled: 'yes' }), /enabled must be/);
});
