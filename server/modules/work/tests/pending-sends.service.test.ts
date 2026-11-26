import assert from 'node:assert/strict';
import test from 'node:test';

import { cancelSend, dismissSend, getSend, listSends, scheduleSend } from '../services/pending-sends.service.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a scheduled send goes out after the delay without anyone waiting for it', async () => {
  let runs = 0;
  const send = scheduleSend({ projectPath: '/p/a', label: 'Reply to James', itemId: 'C1:1.2', delayMs: 30 }, async () => {
    runs += 1;
  });
  assert.equal(send.state, 'pending');
  assert.equal(listSends('/p/a').length, 1);
  await wait(60);
  assert.equal(runs, 1);
  assert.equal(getSend(send.id)?.state, 'sent');
  assert.equal(listSends('/p/a').length, 0);
});

test('cancel before the delay stops it; cancel after reports it was sent', async () => {
  let runs = 0;
  const early = scheduleSend({ projectPath: '/p/b', label: 'x', delayMs: 30 }, async () => { runs += 1; });
  assert.equal(cancelSend(early.id)?.state, 'cancelled');
  const late = scheduleSend({ projectPath: '/p/b', label: 'y', delayMs: 5 }, async () => { runs += 1; });
  await wait(30);
  assert.equal(cancelSend(late.id)?.state, 'sent');
  assert.equal(runs, 1);
  assert.equal(cancelSend('missing'), null);
});

test('a failure stays listed with its error until dismissed', async () => {
  const send = scheduleSend({ projectPath: '/p/c', label: 'DM to Nick', delayMs: 1 }, async () => {
    throw new Error('channel_not_found');
  });
  await wait(20);
  const [listed] = listSends('/p/c');
  assert.equal(listed.state, 'failed');
  assert.equal(listed.error, 'channel_not_found');
  assert.equal(dismissSend(send.id), true);
  assert.equal(listSends('/p/c').length, 0);
});

test('the delay is capped', () => {
  const send = scheduleSend({ projectPath: '/p/d', label: 'z', delayMs: 10 * 60_000 }, async () => undefined);
  assert.ok(send.sendAt - Date.now() <= 15_000);
  cancelSend(send.id);
});
