/**
 * Kvn: a project's sessions as cards (title, last exchange, model, linked Work
 * items) and a full-text search through what was said in them, so a session
 * can be found by its content rather than by its title.
 *
 * Transcripts are read once and cached by file size + mtime; only the
 * conversation text is kept (user prompts and assistant replies), never tool
 * output, hooks or system reminders.
 */
import fs from 'node:fs/promises';

import { projectsDb, sessionsDb, sessionTopicsDb } from '@/modules/database/index.js';
import { workItemsBySession, type SessionWorkItem } from '@/modules/work/index.js';

type Turn = { role: 'user' | 'assistant'; text: string; at: string | null };

type Parsed = {
  model: string | null;
  turns: Turn[];
  userTurns: number;
};

export type SessionCard = {
  id: string;
  title: string;
  /** Generated topic line (what the sidebar shows under the name). */
  topic: string | null;
  provider: string;
  model: string | null;
  createdAt: string;
  lastActivity: string;
  userTurns: number;
  firstPrompt: string | null;
  lastUser: { text: string; at: string | null } | null;
  lastAssistant: { text: string; at: string | null } | null;
  forkedFrom: string | null;
  workItems: SessionWorkItem[];
  /** Set when a search matched: where, and the text around it. */
  match?: { in: 'title' | 'user' | 'assistant'; snippet: string };
};

/** Per transcript: how far it was read, and what was found so far (transcripts only grow). */
const cache = new Map<string, { offset: number; parsed: Parsed; reading: Promise<Parsed> | null }>();
const MAX_TURN_CHARS = 4000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text: string } => Boolean(part) && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** Machine text that is not something the user typed or Claude answered in prose. */
function isNoise(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed
    || trimmed.startsWith('<')
    || trimmed.startsWith('Caveat:')
    || trimmed.startsWith('[Request interrupted')
    || trimmed === 'No response requested.';
}

const ENTRY_MARKERS = [Buffer.from('"type":"user"'), Buffer.from('"type":"assistant"')];

function parseLine(lineBytes: Buffer, parsed: Parsed): void {
  // Cheap byte check first: most lines (tool output, hooks, queue ops) are skipped unparsed.
  if (!ENTRY_MARKERS.some((marker) => lineBytes.includes(marker))) return;
  const line = lineBytes.toString('utf8');
  {
    let entry: { type?: string; isMeta?: boolean; isSidechain?: boolean; isCompactSummary?: boolean; timestamp?: string; message?: { model?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.isMeta || entry.isSidechain || entry.isCompactSummary || !entry.message) return;
    if (entry.type === 'user') {
      const content = entry.message.content;
      if (Array.isArray(content) && content.some((part) => (part as { type?: string })?.type === 'tool_result')) return;
      const text = textOf(content);
      if (isNoise(text)) return;
      parsed.userTurns += 1;
      parsed.turns.push({ role: 'user', text: text.slice(0, MAX_TURN_CHARS), at: entry.timestamp ?? null });
    } else if (entry.type === 'assistant') {
      const model = entry.message.model;
      if (model && model !== '<synthetic>') parsed.model = model;
      const text = textOf(entry.message.content);
      if (isNoise(text)) return;
      const last = parsed.turns[parsed.turns.length - 1];
      // One reply arrives as several entries; keep them as one turn.
      if (last?.role === 'assistant') {
        last.text = `${last.text}\n${text}`.slice(0, MAX_TURN_CHARS);
        last.at = entry.timestamp ?? last.at;
      } else {
        parsed.turns.push({ role: 'assistant', text: text.slice(0, MAX_TURN_CHARS), at: entry.timestamp ?? null });
      }
    }
  }
}

/** Reads the bytes added since the last call (whole lines only) into the cached result. */
async function readNewBytes(jsonlPath: string, state: { offset: number; parsed: Parsed }): Promise<Parsed> {
  const handle = await fs.open(jsonlPath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < state.offset) {
      state.offset = 0;
      state.parsed = { model: null, turns: [], userTurns: 0 };
    }
    let carry = Buffer.alloc(0);
    let position = state.offset;
    while (position < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let start = 0;
      for (let index = data.indexOf(NEWLINE); index !== -1; index = data.indexOf(NEWLINE, start)) {
        parseLine(data.subarray(start, index), state.parsed);
        start = index + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    // Only complete lines count as read; a half-written last line is read next time.
    state.offset = position - carry.length;
    return state.parsed;
  } finally {
    await handle.close();
  }
}

async function readParsed(jsonlPath: string | null): Promise<Parsed | null> {
  if (!jsonlPath) return null;
  let state = cache.get(jsonlPath);
  if (!state) {
    state = { offset: 0, parsed: { model: null, turns: [], userTurns: 0 }, reading: null };
    cache.set(jsonlPath, state);
  }
  if (state.reading) return state.reading;
  const current = state;
  current.reading = readNewBytes(jsonlPath, current)
    .catch(() => current.parsed)
    .finally(() => {
      current.reading = null;
    });
  return current.reading;
}

/** Reads recently active transcripts in the background, so the first overview opens fast. */
export async function warmSessionOverview(): Promise<void> {
  const since = Date.now() - 14 * 86_400_000;
  const rows = sessionsDb.getAllSessions()
    .filter((row) => row.jsonl_path && Date.parse(row.updated_at) > since)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .slice(0, 80);
  for (const row of rows) {
    await readParsed(row.jsonl_path);
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function snippetAround(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const index = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)));
  const start = Math.max(0, index - 70);
  const end = Math.min(flat.length, index + 150);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

export async function listSessionCards(projectId: string, options: { query?: string; limit?: number } = {}): Promise<{ cards: SessionCard[]; total: number }> {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) return { cards: [], total: 0 };
  const rows = sessionsDb.getSessionsByProjectPath(projectPath)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const words = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, Math.min(options.limit ?? 60, 200));
  // Searching looks through every session of the project; browsing only the newest.
  const candidates = words.length ? rows.slice(0, 400) : rows.slice(0, limit);
  const workItems = await workItemsBySession(projectPath).catch(() => new Map<string, SessionWorkItem[]>());

  const cards: SessionCard[] = [];
  for (const row of candidates) {
    const parsed = await readParsed(row.jsonl_path);
    const turns = parsed?.turns ?? [];
    const firstUser = turns.find((t) => t.role === 'user') ?? null;
    const lastUser = [...turns].reverse().find((t) => t.role === 'user') ?? null;
    const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant') ?? null;
    const topic = sessionTopicsDb.getTopic(row.session_id);
    const title = row.custom_name || topic || (firstUser ? oneLine(firstUser.text, 80) : 'New session');
    const items = workItems.get(row.session_id) ?? [];

    let match: SessionCard['match'];
    if (words.length) {
      const head = `${title} ${topic ?? ''} ${items.map((i) => `${i.label} ${i.title}`).join(' ')}`.toLowerCase();
      if (words.every((w) => head.includes(w))) {
        match = { in: 'title', snippet: topic ?? title };
      } else {
        const all = turns.map((t) => t.text.toLowerCase()).join('\n');
        if (!words.every((w) => all.includes(w) || head.includes(w))) continue;
        // Show the newest turn that mentions the words (the most likely "that conversation").
        const score = (t: Turn) => words.filter((w) => t.text.toLowerCase().includes(w)).length;
        const hit = [...turns].reverse().reduce((best, t) => (score(t) > score(best) ? t : best));
        match = { in: hit.role, snippet: snippetAround(hit.text, words) };
      }
    }

    cards.push({
      id: row.session_id,
      title,
      topic,
      provider: row.provider,
      model: row.model ?? parsed?.model ?? null,
      createdAt: row.created_at,
      lastActivity: lastAssistant?.at ?? lastUser?.at ?? row.updated_at,
      userTurns: parsed?.userTurns ?? 0,
      firstPrompt: firstUser ? oneLine(firstUser.text, 240) : null,
      lastUser: lastUser ? { text: oneLine(lastUser.text, 240), at: lastUser.at } : null,
      lastAssistant: lastAssistant ? { text: oneLine(lastAssistant.text, 320), at: lastAssistant.at } : null,
      forkedFrom: row.forked_from_session_id,
      workItems: items,
      ...(match ? { match } : {}),
    });
    if (words.length && cards.length >= limit) break;
  }
  cards.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  return { cards, total: rows.length };
}
