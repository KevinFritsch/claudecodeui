/**
 * "Compose": the user describes a Slack message in plain words ("ask James if
 * we should replace the day 10 prize, it's out of stock"); we work out who it
 * is for, whether it continues an existing thread, and the message itself
 * (corrected, in the user's voice). The user then reviews it and picks Draft
 * or Send. Nothing is posted until that second step.
 *
 * - Recipients come from the workspace member list plus everyone seen in
 *   recent conversations (external Slack Connect guests are not in the member
 *   list), and the channels the user belongs to.
 * - Understanding the request is one Sonnet call through the local CLI.
 * - Delivery: messages to channels are posted with the user's token. DMs and
 *   all drafts go through the claude.ai Slack connector (a small Haiku run):
 *   the token cannot open DMs (no im:write) and Slack has no public draft API.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import { readVoiceGuide, runClaude } from './ai-reply.service.js';
import { client, renderText, type SlackClient } from './slack.service.js';
import type { WorkSecrets } from './work-config.service.js';

export type ComposeTarget = { kind: 'dm' | 'channel'; id: string; label: string };

/** A message the new one could reply to; `channel` is where that thread lives (may differ from the person's DM). */
export type ThreadCandidate = { ts: string; author: string; text: string; permalink: string; channel: ComposeTarget };

export type ComposePreview = {
  target: ComposeTarget | null;
  /** Where the recipient was ambiguous or unknown, what Claude could not settle. */
  note: string | null;
  text: string;
  /** Recent messages in that conversation matching what the user referred to; reply in one or post new. */
  threads: ThreadCandidate[];
  suggestedThreadTs: string | null;
  directory: ComposeTarget[];
};

type Directory = { people: ComposeTarget[]; channels: ComposeTarget[]; at: number };
let directoryCache: Directory | null = null;
const DIRECTORY_TTL_MS = 60 * 60_000;

async function buildDirectory(slack: SlackClient, me: string): Promise<Directory> {
  if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS) return directoryCache;
  const people = new Map<string, ComposeTarget>();
  const channels = new Map<string, ComposeTarget>();

  type Member = { id: string; name: string; deleted?: boolean; is_bot?: boolean; real_name?: string; profile?: { display_name?: string; real_name?: string } };
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const data = await slack.call<{ members: Member[]; response_metadata?: { next_cursor?: string } }>('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
    for (const m of data.members) {
      if (m.deleted || m.is_bot || m.id === 'USLACKBOT' || m.id === me) continue;
      const label = m.profile?.real_name || m.real_name || m.profile?.display_name || m.name;
      people.set(m.id, { kind: 'dm', id: m.id, label: `${label} (@${m.profile?.display_name || m.name})` });
    }
    cursor = data.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }

  // Slack Connect guests (e.g. agency people) are missing from users.list: take
  // everyone who wrote in the user's conversations over the last month.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  type Match = { user?: string; username?: string; channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_channel?: boolean; is_private?: boolean } };
  for (const query of [`<@${me}> after:${since}`, `from:<@${me}> after:${since}`]) {
    for (let page = 1; page <= 3; page += 1) {
      const data = await slack.call<{ messages: { matches: Match[]; paging?: { pages: number } } }>('search.messages', { query, count: 100, page, sort: 'timestamp' });
      for (const m of data.messages.matches) {
        if (m.user && m.user !== me && !people.has(m.user)) {
          try {
            const info = await slack.call<{ user: { name: string; is_bot?: boolean; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>('users.info', { user: m.user });
            if (!info.user.is_bot) {
              const label = info.user.profile?.real_name || info.user.real_name || info.user.profile?.display_name || info.user.name;
              people.set(m.user, { kind: 'dm', id: m.user, label: `${label} (@${info.user.profile?.display_name || info.user.name})` });
            }
          } catch {
            /* skip unknown users */
          }
        }
        if (!m.channel.is_im && !m.channel.is_mpim && m.channel.name && !channels.has(m.channel.id)) {
          channels.set(m.channel.id, { kind: 'channel', id: m.channel.id, label: `#${m.channel.name}` });
        }
      }
      if ((data.messages.paging?.pages ?? 1) <= page) break;
    }
  }

  type Channel = { id: string; name: string; is_member?: boolean };
  cursor = '';
  for (let page = 0; page < 5; page += 1) {
    const data = await slack.call<{ channels: Channel[]; response_metadata?: { next_cursor?: string } }>('conversations.list', {
      types: 'public_channel,private_channel', exclude_archived: 'true', limit: 500, ...(cursor ? { cursor } : {}),
    });
    for (const c of data.channels) {
      if (c.is_member && !channels.has(c.id)) channels.set(c.id, { kind: 'channel', id: c.id, label: `#${c.name}` });
    }
    cursor = data.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }

  directoryCache = {
    people: [...people.values()].sort((a, b) => a.label.localeCompare(b.label)),
    channels: [...channels.values()].sort((a, b) => a.label.localeCompare(b.label)),
    at: Date.now(),
  };
  return directoryCache;
}

function parseJson(raw: string): Record<string, unknown> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not understand the request, try rephrasing it.');
  return JSON.parse(match[0]) as Record<string, unknown>;
}

async function findThreads(slack: SlackClient, target: ComposeTarget, hint: string, me: string): Promise<ThreadCandidate[]> {
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const where = target.kind === 'channel' ? `in:<#${target.id}>` : `from:<@${target.id}>`;
  type Match = { ts: string; user?: string; username?: string; text?: string; permalink: string; channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean } };
  const data = await slack.call<{ messages: { matches: Match[] } }>('search.messages', {
    query: `${hint} ${where} after:${since}`, count: 8, sort: 'score',
  });
  const matches = data.messages.matches.filter((m) => target.kind === 'channel' || m.channel.is_im || m.user === target.id);
  const out: ThreadCandidate[] = [];
  for (const m of matches.slice(0, 5)) {
    const threadTs = new URL(m.permalink).searchParams.get('thread_ts') ?? m.ts;
    if (out.some((c) => c.ts === threadTs)) continue;
    out.push({
      ts: threadTs,
      author: m.user === me ? 'you' : (m.username ?? 'someone'),
      text: (await renderText(slack, m.text ?? '')).slice(0, 220),
      permalink: m.permalink,
      channel: m.channel.is_im
        ? { kind: 'dm', id: m.channel.id, label: 'DM' }
        : { kind: 'channel', id: m.channel.id, label: m.channel.is_mpim ? 'group DM' : `#${m.channel.name ?? m.channel.id}` },
    });
  }
  return out;
}

export async function prepareMessage(
  secrets: WorkSecrets,
  options: { me: string; instruction: string; voiceGuideFile?: string; model?: string },
): Promise<ComposePreview> {
  const slack = client(secrets);
  const directory = await buildDirectory(slack, options.me);
  const all = [...directory.people, ...directory.channels];
  const prompt = [
    'You turn Kevin\'s note into one Slack message he will send (he is a developer at GolfN). Follow his voice guide.',
    '',
    '<voice_guide>',
    readVoiceGuide(options.voiceGuideFile),
    '</voice_guide>',
    '',
    'People Kevin can DM (id: name):',
    ...directory.people.map((p) => `${p.id}: ${p.label}`),
    '',
    'Channels (id: name):',
    ...directory.channels.map((c) => `${c.id}: ${c.label}`),
    '',
    `Kevin's note: ${options.instruction}`,
    '',
    'Rules: the message must say what Kevin wants to say, only corrected (spelling, grammar, flow) and in his voice; do not add facts, promises or extra sentences. Keep a greeting only if Kevin wrote one. If the note names a person, the target is that person\'s DM unless it says to post in a channel. If it refers to an existing conversation ("in the thread about X", "reply to his message about Y"), give a short search query for it.',
    'Answer with JSON only: {"targetId": "<id from the lists or null>", "note": "<short note if the recipient is ambiguous or unknown, else null>", "threadQuery": "<2-5 keywords or null>", "text": "<the message>"}',
  ].join('\n');
  const parsed = parseJson(await runClaude(prompt, options.model ?? 'sonnet'));
  const target = all.find((t) => t.id === parsed.targetId) ?? null;
  const threadQuery = typeof parsed.threadQuery === 'string' && parsed.threadQuery.trim() ? parsed.threadQuery.trim() : null;
  let threads: ThreadCandidate[] = [];
  if (target && threadQuery) {
    try {
      threads = await findThreads(slack, target, threadQuery, options.me);
    } catch (error) {
      console.warn('[work] thread search failed', (error as Error).message);
    }
  }
  return {
    target,
    note: typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note : (target ? null : 'Could not tell who this is for: pick the recipient.'),
    text: typeof parsed.text === 'string' ? parsed.text.trim() : '',
    threads,
    suggestedThreadTs: threads[0]?.ts ?? null,
    directory: all,
  };
}

/** One tool call through the claude.ai Slack connector (DMs and drafts). */
function connectorCall(tool: 'slack_send_message' | 'slack_send_message_draft', args: Record<string, string>): Promise<void> {
  const prompt = [
    `Call the tool ${tool} exactly once with exactly these arguments (JSON): ${JSON.stringify(args)}.`,
    'Do not change, shorten or reformat the message text in any way.',
    'Then reply with only OK if it succeeded, or ERROR: <reason> if it failed.',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--no-session-persistence', '--model', 'haiku', '--allowedTools', `mcp__claude_ai_Slack__${tool}`], {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Slack took too long to answer.'));
    }, 120_000);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const answer = output.trim().split('\n').pop() ?? '';
      if (/^OK\b/.test(answer)) resolve();
      else reject(new Error(answer.replace(/^ERROR:\s*/, '') || 'The Slack connector did not confirm.'));
    });
    child.stdin.end(prompt);
  });
}

export async function deliverMessage(
  secrets: WorkSecrets,
  options: { mode: 'draft' | 'send'; target: ComposeTarget; threadTs: string | null; text: string },
): Promise<{ via: 'api' | 'connector' }> {
  const { target, threadTs, text } = options;
  // A conversation id (C… channel, G… private, D… existing DM) can be posted to
  // with the user's token; only a bare user id (new DM) needs the connector.
  if (options.mode === 'send' && !target.id.startsWith('U')) {
    await client(secrets).call('chat.postMessage', { channel: target.id, text, ...(threadTs ? { thread_ts: threadTs } : {}) }, true);
    return { via: 'api' };
  }
  const args: Record<string, string> = { channel_id: target.id, message: text };
  if (threadTs) args.thread_ts = threadTs;
  await connectorCall(options.mode === 'draft' ? 'slack_send_message_draft' : 'slack_send_message', args);
  return { via: 'connector' };
}
