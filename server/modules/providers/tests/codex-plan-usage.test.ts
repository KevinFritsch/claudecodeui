import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codexPlanUsageService } from '@/modules/providers/services/codex-plan-usage.service.js';

/**
 * Codex usage is read from the newest session rollout's last rate-limit
 * report, against a temporary CODEX_HOME.
 */

const withCodexHome = async (setup: (home: string) => Promise<void>, run: () => Promise<void>) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await setup(home);
    await run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
};

const rateLimitLine = (primaryPercent: number, primaryResetSeconds: number) => JSON.stringify({
  timestamp: '2026-10-01T10:57:08.484Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    rate_limits: {
      primary: { used_percent: primaryPercent, window_minutes: 300, resets_at: primaryResetSeconds },
      secondary: { used_percent: 10, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86_400 },
      plan_type: 'plus',
    },
  },
});

test('reports not connected when Codex has no login', async () => {
  await withCodexHome(async () => {}, async () => {
    const usage = await codexPlanUsageService.getPlanUsage();
    assert.equal(usage.connected, false);
    assert.deepEqual(usage.limits, []);
  });
});

test('reads the latest rate-limit report and zeroes a window that has since reset', async () => {
  await withCodexHome(async (home) => {
    await writeFile(path.join(home, 'auth.json'), '{}');
    const dayDirectory = path.join(home, 'sessions', '2026', '10', '01');
    await mkdir(dayDirectory, { recursive: true });
    const future = Math.floor(Date.now() / 1000) + 3600;
    const past = Math.floor(Date.now() / 1000) - 60;
    await writeFile(
      path.join(dayDirectory, 'rollout-a.jsonl'),
      [rateLimitLine(50, future), '{"type":"other"}', rateLimitLine(3, past), ''].join('\n'),
    );
  }, async () => {
    const usage = await codexPlanUsageService.getPlanUsage();
    assert.equal(usage.connected, true);
    assert.equal(usage.planType, 'plus');
    assert.deepEqual(usage.limits.map((limit) => [limit.label, limit.percent]), [
      ['5-hour limit', 0],
      ['Weekly limit', 10],
    ]);
    assert.equal(usage.limits[0].resetsAt, null);
  });
});
