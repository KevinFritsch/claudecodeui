import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionTopicsDb, sessionsDb } from '@/modules/database/index.js';
import {
  buildTopicPrompt,
  cleanTopic,
  extractLatestExchange,
  refreshSessionTopic,
} from '@/modules/session-topics/services/session-topics.service.js';

const claudeLine = (role: 'user' | 'assistant', content: unknown) =>
  JSON.stringify({ type: role, message: { role, content } });

test('extractLatestExchange keeps the latest user turns and reply, skipping tool noise', () => {
  const transcript = [
    claudeLine('user', 'set up the hub'),
    claudeLine('assistant', [{ type: 'text', text: 'Hub done.' }]),
    claudeLine('user', 'now fix the tabs <system-reminder>ignore me</system-reminder>'),
    claudeLine('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    claudeLine('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }]),
    claudeLine('assistant', [{ type: 'text', text: 'Tabs fixed.' }]),
    'not json',
  ].join('\n');

  assert.deepEqual(extractLatestExchange(transcript), {
    userTurns: ['set up the hub', 'now fix the tabs'],
    assistant: 'Tabs fixed.',
  });
});

test('extractLatestExchange reads Codex transcripts', () => {
  const transcript = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rename the API' }] },
  });
  assert.deepEqual(extractLatestExchange(transcript).userTurns, ['rename the API']);
});

test('cleanTopic trims quotes, labels, punctuation and length', () => {
  assert.equal(cleanTopic('"Fixing tabs UI."\n'), 'Fixing tabs UI');
  assert.equal(cleanTopic('Topic: adding session topics'), 'adding session topics');
  assert.equal(cleanTopic('   \n'), null);
  const long = cleanTopic('debugging the extremely long certificate renewal pipeline again');
  assert.ok(long && long.length <= 40 && !long.endsWith(' '));
});

test('buildTopicPrompt mentions the previous label', () => {
  const prompt = buildTopicPrompt({ userTurns: ['fix tabs'], assistant: 'done' }, 'fixing tabs UI');
  assert.match(prompt, /Previous label.*fixing tabs UI/);
  assert.match(prompt, /User: fix tabs/);
  assert.match(prompt, /Assistant: done/);
});

test('refreshSessionTopic stores a topic and skips an unchanged exchange', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-topics-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const transcriptPath = path.join(tempDirectory, 'session.jsonl');
    await writeFile(transcriptPath, `${claudeLine('user', 'please fix the tabs')}\n`);
    const sessionId = sessionsDb.createSession('topic-session', 'claude', tempDirectory, undefined, undefined, undefined, transcriptPath);

    const prompts: string[] = [];
    const runner = async (prompt: string) => {
      prompts.push(prompt);
      return 'fixing tabs UI\n';
    };

    assert.equal(await refreshSessionTopic(sessionId, runner), 'fixing tabs UI');
    assert.equal(sessionTopicsDb.getTopic(sessionId), 'fixing tabs UI');

    // Same exchange: no second model call.
    assert.equal(await refreshSessionTopic(sessionId, runner), null);
    assert.equal(prompts.length, 1);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
