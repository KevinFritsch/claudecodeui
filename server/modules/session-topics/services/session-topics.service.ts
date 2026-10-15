import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { sessionTopicsDb, sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted, chatRunRegistry } from '@/modules/websocket/index.js';

/**
 * Keeps a short "what is this conversation about right now" line per session
 * (e.g. "fixing tabs UI"), shown under the session name in the sidebar.
 *
 * After a run ends, the tail of the session's transcript (latest user turns
 * plus the latest assistant reply) is summarised by Haiku through the local
 * `claude` CLI, using the machine's existing login and saving no session.
 * Generation is debounced per session, throttled, skipped when the exchange is
 * unchanged, and runs one at a time so it never competes with real work.
 */

/** Turns a prompt into a raw model answer. Injected in tests. */
export type TopicRunner = (prompt: string) => Promise<string>;

const DEBOUNCE_MS = 5_000;
const MIN_INTERVAL_MS = 60_000;
const RUNNER_TIMEOUT_MS = 60_000;
// Long agentic runs bury the user's words under tool output, so the read widens until it finds them.
const TAIL_SIZES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const MAX_TOPIC_LENGTH = 40;
const MAX_USER_TURNS = 2;
const MAX_TURN_CHARS = 1_200;
const BACKFILL_DELAY_MS = 30_000;
const BACKFILL_SESSIONS = 15;

type Exchange = { userTurns: string[]; assistant: string | null };

/** Runs Haiku through the `claude` CLI: no settings, no slash commands, nothing persisted. */
export const claudeCliTopicRunner: TopicRunner = (prompt) => new Promise((resolve, reject) => {
  const child = spawn(
    'claude',
    ['-p', '--setting-sources', '', '--no-session-persistence', '--model', 'haiku', '--disable-slash-commands'],
    // A neutral cwd keeps project CLAUDE.md files and hooks out of the call.
    { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let output = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('topic generation timed out'));
  }, RUNNER_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(output);
    else reject(new Error(`claude exited with code ${code}`));
  });
  child.stdin.end(prompt);
});

/** Drops the wrappers the CLI injects into user turns (reminders, command echoes, …). */
function cleanTurnText(text: string): string {
  return text
    .replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|ide_[a-z_]+)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Only plain text blocks count; tool calls and tool results are noise here.
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const { type, text } = block as { type?: unknown; text?: unknown };
      return (type === 'text' || type === 'input_text' || type === 'output_text') && typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Pulls `{role, text}` out of one transcript line, for Claude and Codex transcripts alike. */
function readTurn(line: string): { role: 'user' | 'assistant'; text: string } | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record.isMeta || record.isSidechain || record.isCompactSummary) return null;

  // Claude: {type: 'user'|'assistant', message: {role, content}}
  const message = record.message as { role?: unknown; content?: unknown } | undefined;
  // Codex: {type: 'response_item', payload: {type: 'message', role, content}}
  const payload = record.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
  const source = message && (record.type === 'user' || record.type === 'assistant')
    ? message
    : payload?.type === 'message' ? payload : null;
  if (!source || (source.role !== 'user' && source.role !== 'assistant')) return null;

  const text = cleanTurnText(textOfContent(source.content));
  return text ? { role: source.role, text } : null;
}

/** The latest exchange in a transcript: the last few user turns and the last assistant reply. */
export function extractLatestExchange(transcriptTail: string): Exchange {
  const userTurns: string[] = [];
  let assistant: string | null = null;
  const lines = transcriptTail.split('\n');
  for (let index = lines.length - 1; index >= 0 && userTurns.length < MAX_USER_TURNS; index -= 1) {
    const turn = readTurn(lines[index]);
    if (!turn) continue;
    if (turn.role === 'assistant') {
      // The newest reply, i.e. the one after the latest user turn.
      if (assistant === null && userTurns.length === 0) assistant = turn.text.slice(0, MAX_TURN_CHARS);
    } else if (!turn.text.startsWith('Caveat:')) {
      userTurns.unshift(turn.text.slice(0, MAX_TURN_CHARS));
    }
  }
  return { userTurns, assistant };
}

export function buildTopicPrompt(exchange: Exchange, previousTopic: string | null): string {
  return [
    'You label coding-assistant conversations for a sidebar.',
    'Give the CURRENT subject of the conversation below in 2 to 5 words, lowercase except names,',
    'like "fixing tabs UI", "adding session topics", "debugging cert renewal".',
    'Focus on the latest messages. Reply with the label only: no quotes, no punctuation, no explanation.',
    previousTopic ? `Previous label (keep it if the subject has not changed): ${previousTopic}` : '',
    '',
    ...exchange.userTurns.map((text) => `User: ${text}`),
    exchange.assistant ? `Assistant: ${exchange.assistant}` : '',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

/** Normalises the model's answer into a short single-line label, or null when unusable. */
export function cleanTopic(raw: string): string | null {
  const firstLine = raw.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  let topic = firstLine
    .replace(/^(label|topic|subject)\s*:\s*/i, '')
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .replace(/[.!?;:,]+$/, '')
    .trim();
  if (!topic) return null;
  if (topic.length > MAX_TOPIC_LENGTH) {
    const cut = topic.slice(0, MAX_TOPIC_LENGTH);
    topic = (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim();
  }
  return topic || null;
}

async function readLatestExchange(filePath: string): Promise<Exchange> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    let exchange: Exchange = { userTurns: [], assistant: null };
    for (const tailSize of TAIL_SIZES) {
      const start = Math.max(0, size - tailSize);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8');
      // A partial first line is useless; drop it when the read started mid-file.
      exchange = extractLatestExchange(start > 0 ? text.slice(text.indexOf('\n') + 1) : text);
      if (exchange.userTurns.length >= MAX_USER_TURNS || start === 0) break;
    }
    return exchange;
  } finally {
    await handle.close();
  }
}

/**
 * Generates and stores a fresh topic for one session. Returns the new topic,
 * or null when nothing changed (no transcript, same exchange, unusable answer).
 */
export async function refreshSessionTopic(sessionId: string, runner: TopicRunner): Promise<string | null> {
  const row = sessionsDb.getSessionById(sessionId);
  if (!row?.jsonl_path) return null;

  let exchange: Exchange;
  try {
    exchange = await readLatestExchange(row.jsonl_path);
  } catch {
    return null;
  }
  if (exchange.userTurns.length === 0) return null;

  const sourceHash = createHash('sha1')
    .update(JSON.stringify(exchange))
    .digest('hex');
  const previous = sessionTopicsDb.getRecord(sessionId);
  if (previous?.sourceHash === sourceHash) return null;

  const topic = cleanTopic(await runner(buildTopicPrompt(exchange, previous?.topic ?? null)));
  if (!topic) return null;

  sessionTopicsDb.setTopic(sessionId, topic, sourceHash);
  return previous?.topic === topic ? null : topic;
}

// ---- scheduling ------------------------------------------------------------

const debounceTimers = new Map<string, NodeJS.Timeout>();
const lastRunAt = new Map<string, number>();
const queue: string[] = [];
let running = false;
let activeRunner: TopicRunner | null = null;
let unsubscribeRunCompleted: (() => void) | null = null;
let backfillTimer: NodeJS.Timeout | null = null;

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0 && activeRunner) {
      const sessionId = queue.shift() as string;
      lastRunAt.set(sessionId, Date.now());
      try {
        const topic = await refreshSessionTopic(sessionId, activeRunner);
        if (topic) await broadcastSessionUpserted(sessionId, 'topic');
      } catch (error) {
        console.warn('[session-topics] could not refresh topic for', sessionId, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    running = false;
  }
}

/** Asks for a topic refresh once the session has been quiet for a moment (and not too often). */
export function scheduleTopicRefresh(sessionId: string): void {
  if (!activeRunner) return;
  clearTimeout(debounceTimers.get(sessionId));
  const sinceLast = Date.now() - (lastRunAt.get(sessionId) ?? 0);
  const delay = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - sinceLast);
  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId);
    if (!queue.includes(sessionId)) queue.push(sessionId);
    void drainQueue();
  }, delay);
  timer.unref?.();
  debounceTimers.set(sessionId, timer);
}

export function initializeSessionTopics(runner: TopicRunner = claudeCliTopicRunner): void {
  if (process.env.CLOUDCLI_SESSION_TOPICS === 'false') return;
  activeRunner = runner;
  unsubscribeRunCompleted = chatRunRegistry.onRunCompleted((sessionId) => scheduleTopicRefresh(sessionId));

  // Give the most recent sessions a topic without waiting for their next run.
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    for (const row of sessionsDb.getRecentSessionsPage(BACKFILL_SESSIONS, 0).sessions) {
      if (row.jsonl_path && !sessionTopicsDb.getTopic(row.session_id) && !queue.includes(row.session_id)) {
        queue.push(row.session_id);
      }
    }
    void drainQueue();
  }, BACKFILL_DELAY_MS);
  backfillTimer.unref?.();
}

export function closeSessionTopics(): void {
  unsubscribeRunCompleted?.();
  unsubscribeRunCompleted = null;
  activeRunner = null;
  if (backfillTimer) clearTimeout(backfillTimer);
  backfillTimer = null;
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  queue.length = 0;
}
