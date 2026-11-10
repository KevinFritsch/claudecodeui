/**
 * Slack mentions for the Work dashboard, acting as the user through their
 * user token (xoxp): nothing is ever posted as a bot.
 *
 * "Needs you" = a message that tags the user, not written by them, that they
 * have neither ✅'d nor replied to (in its thread, after it). Slack search
 * cannot exclude reactions, so each candidate needs one conversations.replies
 * call; answered messages are remembered so only open ones are re-checked.
 */

import { EMOJI_SHORTCODES } from './emoji-shortcodes.js';
import type { WorkSecrets } from './work-config.service.js';

export type SlackProjectConfig = {
  /** The user's Slack member id, e.g. U019DMGRQHM. */
  userId: string;
  /** How far back to look for mentions. Default 7. */
  lookbackDays?: number;
  /** Channel names (without #) to ignore. */
  excludeChannels?: string[];
  /** Voice guide used when drafting replies (default: the golfn slack-voice skill). */
  voiceGuideFile?: string;
  /** Model for drafted replies. Default "sonnet". */
  replyModel?: string;
};

export type SlackMention = {
  /** `${channelId}:${ts}`, stable id used for links and actions. */
  id: string;
  channelId: string;
  channelName: string;
  channelKind: 'channel' | 'private' | 'dm' | 'group';
  ts: string;
  /** Thread root ts the message lives in (its own ts when it is not in a thread). */
  threadTs: string;
  author: string;
  authorId: string | null;
  /** Slack profile picture URL, when the author is a person. */
  authorAvatar: string | null;
  /** Text with user mentions and links rendered readable. */
  text: string;
  permalink: string;
  /** Emoji names the user reacted with, other than a checkmark (e.g. "eyes" = on it). */
  myReactions: string[];
  replyCount: number;
};

type MentionState = { state: 'open' | 'answered'; checkedAt: number; myReactions: string[]; replyCount: number };

const DONE_REACTIONS = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', 'done']);
const OPEN_RECHECK_MS = 90_000;
/** In a busy channel, only a message from the user within this window counts as their answer. */
const CHANNEL_ANSWER_WINDOW_S = 3 * 3600;

const stateCache = new Map<string, MentionState>();
const userCache = new Map<string, { name: string; avatar: string | null; isBot: boolean }>();
let myHandle: string | null = null;

export class SlackClient {
  constructor(private readonly token: string) {}

  async call<T>(method: string, params: Record<string, string | number>, post = false): Promise<T> {
    const body = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
    const url = post ? `https://slack.com/api/${method}` : `https://slack.com/api/${method}?${body}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(url, {
        method: post ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(post ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: post ? body : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429) {
        const wait = Number(response.headers.get('retry-after') ?? '2');
        await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 10) * 1000));
        continue;
      }
      const data = (await response.json()) as { ok: boolean; error?: string } & T;
      if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? 'unknown error'}`);
      return data;
    }
    throw new Error(`Slack ${method}: rate limited`);
  }
}

export function client(secrets: WorkSecrets): SlackClient {
  if (!secrets.SLACK_USER_TOKEN) throw new Error('Slack is not configured: SLACK_USER_TOKEN is needed in secrets.env.');
  return new SlackClient(secrets.SLACK_USER_TOKEN);
}

export async function userInfo(slack: SlackClient, id: string): Promise<{ name: string; avatar: string | null; isBot: boolean }> {
  const cached = userCache.get(id);
  if (cached) return cached;
  try {
    type Profile = { display_name?: string; real_name?: string; image_72?: string; image_48?: string };
    const data = await slack.call<{ user: { name: string; real_name?: string; is_bot?: boolean; profile?: Profile } }>('users.info', { user: id });
    const profile = data.user.profile ?? {};
    const info = {
      name: profile.display_name || profile.real_name || data.user.real_name || data.user.name,
      avatar: profile.image_72 || profile.image_48 || null,
      isBot: Boolean(data.user.is_bot) || id === 'USLACKBOT',
    };
    userCache.set(id, info);
    return info;
  } catch {
    return { name: id, avatar: null, isBot: false };
  }
}

async function userName(slack: SlackClient, id: string): Promise<string> {
  return (await userInfo(slack, id)).name;
}

/** Turns Slack markup (<@U1>, <#C1|name>, <url|label>) into plain readable text. */
export async function renderText(slack: SlackClient, raw: string): Promise<string> {
  const ids = [...new Set([...raw.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  const names = new Map(await Promise.all(ids.map(async (id) => [id, await userName(slack, id)] as const)));
  return raw
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    // :wave: → 👋 (skin tones dropped; workspace custom emoji stay as text).
    .replace(/:skin-tone-\d:/g, '')
    .replace(/:([a-z0-9_+'-]+):/gi, (whole, name: string) => EMOJI_SHORTCODES[name.toLowerCase()] ?? whole);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

type SearchMatch = {
  ts: string;
  text: string;
  user?: string;
  username?: string;
  permalink: string;
  channel: { id: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
};

type ThreadMessage = { ts: string; user?: string; reactions?: Array<{ name: string; users?: string[] }>; reply_count?: number };

async function checkState(slack: SlackClient, me: string, match: SearchMatch, threadTs: string): Promise<MentionState> {
  const data = await slack.call<{ messages: ThreadMessage[] }>('conversations.replies', {
    channel: match.channel.id,
    ts: threadTs,
    limit: 200,
  });
  const own = data.messages.find((m) => m.ts === match.ts);
  const mine = (own?.reactions ?? []).filter((r) => r.users?.includes(me)).map((r) => r.name);
  const checked = mine.some((name) => DONE_REACTIONS.has(name));
  let replied = data.messages.some((m) => m.user === me && Number(m.ts) > Number(match.ts));

  // A top-level message is often answered in the conversation itself rather
  // than in a thread: any later message from the user counts in a DM or group
  // DM, and one within a few hours counts in a channel.
  if (!checked && !replied && threadTs === match.ts) {
    const isDirect = Boolean(match.channel.is_im || match.channel.is_mpim);
    const latest = isDirect ? undefined : String(Number(match.ts) + CHANNEL_ANSWER_WINDOW_S);
    const history = await slack.call<{ messages: ThreadMessage[] }>('conversations.history', {
      channel: match.channel.id,
      oldest: match.ts,
      ...(latest ? { latest } : {}),
      limit: 50,
    });
    replied = history.messages.some((m) => m.user === me && Number(m.ts) > Number(match.ts));
  }

  return {
    state: checked || replied ? 'answered' : 'open',
    checkedAt: Date.now(),
    myReactions: mine.filter((name) => !DONE_REACTIONS.has(name)),
    replyCount: Math.max(0, (data.messages[0]?.reply_count ?? data.messages.length - 1)),
  };
}

function channelKind(channel: SearchMatch['channel']): SlackMention['channelKind'] {
  if (channel.is_im) return 'dm';
  if (channel.is_mpim) return 'group';
  return channel.is_private ? 'private' : 'channel';
}

/** Open mentions of the user, newest first. */
export async function listOpenMentions(secrets: WorkSecrets, config: SlackProjectConfig): Promise<SlackMention[]> {
  const slack = client(secrets);
  const me = config.userId;
  const since = new Date(Date.now() - (config.lookbackDays ?? 7) * 86_400_000).toISOString().slice(0, 10);
  const excluded = new Set((config.excludeChannels ?? []).map((c) => c.replace(/^#/, '').toLowerCase()));

  // Messages that @-mention the user, plus direct and group DMs sent to them
  // (a DM rarely tags its reader, so mentions alone missed them).
  const search = async (query: string): Promise<SearchMatch[]> => {
    const found: SearchMatch[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const data = await slack.call<{ messages: { matches: SearchMatch[]; paging?: { pages: number } } }>('search.messages', {
        query, sort: 'timestamp', sort_dir: 'desc', count: 100, page,
      });
      found.push(...data.messages.matches);
      if ((data.messages.paging?.pages ?? 1) <= page) break;
    }
    return found;
  };
  const [mentions, toMe] = await Promise.all([search(`<@${me}> after:${since}`), search(`to:me after:${since}`)]);
  const directs = toMe.filter((m) => m.channel.is_im || m.channel.is_mpim);
  const seenIds = new Set<string>();
  const matches = [...mentions, ...directs].filter((m) => {
    const id = `${m.channel.id}:${m.ts}`;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  // Bots (Jira Cloud, webhooks…) are not people waiting on an answer when they DM.
  const isBotAuthor = async (m: SearchMatch) => !m.user || (await userInfo(slack, m.user)).isBot;
  const candidates: SearchMatch[] = [];
  for (const m of matches) {
    if (m.user === me || excluded.has((m.channel.name ?? '').toLowerCase())) continue;
    if ((m.channel.is_im || m.channel.is_mpim) && !mentions.includes(m) && await isBotAuthor(m)) continue;
    candidates.push(m);
  }

  const results = await mapLimit(candidates, 6, async (match): Promise<SlackMention | null> => {
    const id = `${match.channel.id}:${match.ts}`;
    const threadTs = new URL(match.permalink).searchParams.get('thread_ts') ?? match.ts;
    let state = stateCache.get(id);
    if (!state || (state.state === 'open' && Date.now() - state.checkedAt > OPEN_RECHECK_MS)) {
      try {
        state = await checkState(slack, me, match, threadTs);
        stateCache.set(id, state);
      } catch (error) {
        console.warn('[work] slack thread check failed', id, (error as Error).message);
        if (!state) return null;
      }
    }
    if (state.state === 'answered') return null;

    const kind = channelKind(match.channel);
    let channelName = match.channel.name ?? match.channel.id;
    if (kind === 'dm') channelName = `DM · ${match.username ?? (await userName(slack, channelName))}`;
    if (kind === 'group') {
      if (!myHandle) {
        myHandle = await slack.call<{ user: string }>('auth.test', {}).then((d) => d.user).catch(() => '');
      }
      channelName = channelName.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--')
        .filter((handle) => handle !== myHandle).join(', ');
    }

    return {
      id,
      channelId: match.channel.id,
      channelName,
      channelKind: kind,
      ts: match.ts,
      threadTs,
      ...(await (async () => {
        const info = match.user ? await userInfo(slack, match.user) : null;
        return {
          author: info?.name ?? match.username ?? 'unknown',
          authorAvatar: info?.avatar ?? null,
        };
      })()),
      authorId: match.user ?? null,
      text: await renderText(slack, match.text ?? ''),
      permalink: match.permalink,
      myReactions: state.myReactions,
      replyCount: state.replyCount,
    };
  });

  return results.filter((m): m is SlackMention => m !== null);
}

function parseId(id: string): { channel: string; ts: string } {
  const match = /^([A-Z0-9]+):(\d+\.\d+)$/.exec(id);
  if (!match) throw new Error('Invalid Slack message id.');
  return { channel: match[1], ts: match[2] };
}

/** ✅ the message (as the user), which is how they close a request in Slack. */
export async function markDone(secrets: WorkSecrets, id: string): Promise<void> {
  const { channel, ts } = parseId(id);
  try {
    await client(secrets).call('reactions.add', { channel, timestamp: ts, name: 'white_check_mark' }, true);
  } catch (error) {
    if (!/already_reacted/.test((error as Error).message)) throw error;
  }
  const cached = stateCache.get(id);
  stateCache.set(id, { myReactions: [], replyCount: 0, ...cached, state: 'answered', checkedAt: Date.now() });
}

export async function unmarkDone(secrets: WorkSecrets, id: string): Promise<void> {
  const { channel, ts } = parseId(id);
  try {
    await client(secrets).call('reactions.remove', { channel, timestamp: ts, name: 'white_check_mark' }, true);
  } catch (error) {
    if (!/no_reaction/.test((error as Error).message)) throw error;
  }
  stateCache.delete(id);
}

/** Posts a reply in the message's thread, as the user. */
export async function postReply(secrets: WorkSecrets, id: string, threadTs: string, text: string): Promise<{ ts: string }> {
  const { channel } = parseId(id);
  if (!/^\d+\.\d+$/.test(threadTs)) throw new Error('Invalid thread.');
  const data = await client(secrets).call<{ ts: string }>('chat.postMessage', { channel, thread_ts: threadTs, text }, true);
  const cached = stateCache.get(id);
  stateCache.set(id, { myReactions: [], replyCount: 0, ...cached, state: 'answered', checkedAt: Date.now() });
  return { ts: data.ts };
}

/** The message's thread (or the message alone), as readable "Name: text" lines, oldest first. */
export async function readThread(secrets: WorkSecrets, id: string, threadTs: string): Promise<string[]> {
  const { channel } = parseId(id);
  if (!/^\d+\.\d+$/.test(threadTs)) throw new Error('Invalid thread.');
  const slack = client(secrets);
  const data = await slack.call<{ messages: Array<{ ts: string; user?: string; username?: string; text?: string }> }>(
    'conversations.replies',
    { channel, ts: threadTs, limit: 60 },
  );
  return Promise.all(data.messages.map(async (m) => {
    const who = m.user ? await userName(slack, m.user) : (m.username ?? 'bot');
    const text = await renderText(slack, m.text ?? '');
    return `${who}${m.ts === parseId(id).ts ? ' (the message to answer)' : ''}: ${text}`;
  }));
}
