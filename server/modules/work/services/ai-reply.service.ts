/**
 * Drafts a Slack reply in the user's voice with a small one-off Claude call
 * (the local `claude` CLI, Sonnet, no session saved, neutral cwd so no project
 * hooks or CLAUDE.md run). The draft is returned to the dashboard for the user
 * to edit and send; nothing is posted here.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 90_000;
const DEFAULT_VOICE_GUIDE = path.join(os.homedir(), 'Documents/dev/claude-my-plugins/plugins/golfn/skills/slack-voice/SKILL.md');

function runClaude(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--setting-sources', '', '--no-session-persistence', '--model', model, '--disable-slash-commands'],
      { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let errors = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Drafting the reply took too long.'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`claude exited with code ${code}${errors ? `: ${errors.slice(0, 200)}` : ''}`));
    });
    child.stdin.end(prompt);
  });
}

function readVoiceGuide(file: string | undefined): string {
  try {
    return fs.readFileSync(file || DEFAULT_VOICE_GUIDE, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  } catch {
    return 'Write like a developer replying to a teammate: short, direct, friendly, no corporate phrasing. Threads get no greeting.';
  }
}

export async function draftSlackReply(options: {
  thread: string[];
  instruction: string;
  author: string;
  voiceGuideFile?: string;
  model?: string;
}): Promise<string> {
  const prompt = [
    'You draft one Slack reply for Kevin, a developer at GolfN. Follow his voice guide exactly.',
    '',
    '<voice_guide>',
    readVoiceGuide(options.voiceGuideFile),
    '</voice_guide>',
    '',
    '<thread>',
    ...options.thread,
    '</thread>',
    '',
    `Kevin is replying in this thread to ${options.author}.`,
    options.instruction.trim()
      ? `What Kevin wants to say: ${options.instruction.trim()}`
      : 'Kevin gave no instruction: write the most natural short reply to the message to answer.',
    '',
    'Kevin\'s note is the content of the reply: keep its meaning and facts, reshape it into his voice and make it read naturally as an answer to the message. Use the voice tics sparingly (at most one trailing "yes", never two).',
    'Do not invent facts, numbers or promises Kevin did not give. Reply with the message text only: no quotes, no preamble, no explanation.',
  ].join('\n');
  const raw = await runClaude(prompt, options.model ?? 'sonnet');
  return raw.trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
}
