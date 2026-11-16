import { AlertTriangle, Sparkles, Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, CornerDownLeft, ExternalLink, Eye, Hash, Loader2, Lock, MessageCircle, Reply, Send, SmilePlus, Undo2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '@/shared/utils';
import { workApi, type SlackMention } from '@/modules/work/api';
import EmojiPicker, { recordEmojiUse } from '@/modules/work/EmojiPicker';
import { SessionButton, clip, type SessionActions, type SessionSeed } from '@/modules/work/SessionButton';

const SEND_DELAY_MS = 5_000;
const UNDO_WINDOW_MS = 8_000;

function clockTime(ts: string): string {
  const date = new Date(Number(ts) * 1000);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function slackTimeAgo(ts: string): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - Number(ts)));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Kvn: messages that belong together: a thread, or a burst in one DM/group/channel. */
type Conversation = {
  key: string;
  messages: SlackMention[];
  latest: SlackMention;
  /** Replies posted inside a Slack thread (answer there). */
  isThread: boolean;
};

const BURST_GAP_S = 2 * 3600;

export function groupConversations(mentions: SlackMention[]): Conversation[] {
  // A message that opened a thread joins its replies' card.
  const threadRoots = new Set(mentions.filter((m) => m.threadTs !== m.ts).map((m) => `${m.channelId}:${m.threadTs}`));
  const sorted = [...mentions].sort((a, b) => Number(a.ts) - Number(b.ts));
  const groups: Conversation[] = [];
  const current = new Map<string, Conversation>();
  for (const message of sorted) {
    const isThread = message.threadTs !== message.ts || threadRoots.has(`${message.channelId}:${message.ts}`);
    const base = isThread ? `thread:${message.channelId}:${message.threadTs}` : `conv:${message.channelId}`;
    let group = current.get(base);
    if (group && !isThread && Number(message.ts) - Number(group.latest.ts) > BURST_GAP_S) group = undefined;
    if (!group) {
      group = { key: `${base}:${message.ts}`, messages: [], latest: message, isThread };
      current.set(base, group);
      groups.push(group);
    }
    group.messages.push(message);
    group.latest = message;
  }
  return groups.sort((a, b) => Number(b.latest.ts) - Number(a.latest.ts));
}

function authorsOf(conversation: Conversation): SlackMention[] {
  const seen = new Map<string, SlackMention>();
  for (const message of conversation.messages) seen.set(message.authorId ?? message.author, message);
  return [...seen.values()];
}

function conversationSeed(conversation: Conversation): SessionSeed {
  const { latest, messages } = conversation;
  const where = latest.channelKind === 'dm' ? 'a DM' : `#${latest.channelName}`;
  const names = authorsOf(conversation).map((m) => m.author).join(', ');
  const quoted = messages
    .map((m) => `> ${m.author}: ${(m.text || '(no text, open the link)').split('\n').join('\n> ')}`)
    .join('\n');
  return {
    itemType: 'slack',
    itemKey: latest.id,
    sessionName: clip(`slack: ${names} ${latest.text}`, 80),
    prompt: [
      `slack: ${names} in ${where}${conversation.isThread ? ' (thread)' : ''}`,
      latest.permalink,
      '',
      quoted,
      '',
      'Read the whole conversation first (Slack connector), then handle this request. When done, draft my reply (golfn:slack-voice) for me to approve; do not send it.',
      '',
    ].join('\n'),
  };
}

const AVATAR_COLORS = ['bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-fuchsia-500', 'bg-teal-500', 'bg-orange-500'];

function Avatar({ mention, size = 'h-8 w-8' }: { mention: SlackMention; size?: string }) {
  const [failed, setFailed] = useState(false);
  if (mention.authorAvatar && !failed) {
    return <img src={mention.authorAvatar} alt="" onError={() => setFailed(true)} className={cn(size, 'shrink-0 rounded-md object-cover')} />;
  }
  const hash = [...mention.author].reduce((n, c) => n + c.charCodeAt(0), 0);
  return (
    <span className={cn(size, AVATAR_COLORS[hash % AVATAR_COLORS.length], 'flex shrink-0 items-center justify-center rounded-md text-xs font-semibold uppercase text-white')}>
      {mention.author.slice(0, 1)}
    </span>
  );
}

function ChannelIcon({ kind }: { kind: SlackMention['channelKind'] }) {
  const Icon = kind === 'dm' ? MessageCircle : kind === 'group' ? Users : kind === 'private' ? Lock : Hash;
  return <Icon className="h-3 w-3 shrink-0" />;
}

type Reaction = { name: string; char: string | null };
type Closed = { conversation: Conversation; how: 'done' | 'replied' | 'resolved'; at: number; reaction?: Reaction };

/** 👀 means "on it": it marks the message without closing it. */
const OPEN_REACTIONS = new Set(['eyes']);

const COLLAPSED_COUNT = 4;

function ConversationRow({
  conversation,
  projectPath,
  sessions,
  onClosed,
  onReacted,
  isNew,
}: {
  conversation: Conversation;
  isNew: boolean;
  projectPath: string;
  sessions: SessionActions;
  onClosed: (conversation: Conversation, how: Closed['how'], reaction?: Reaction) => void;
  onReacted: (message: SlackMention) => void;
}) {
  const { latest, messages, isThread } = conversation;
  const otherIds = messages.filter((m) => m.id !== latest.id).map((m) => m.id);
  const authors = authorsOf(conversation);
  const [showAll, setShowAll] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [replying, setReplying] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState('');
  const [sendAt, setSendAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<'done' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reactButton, setReactButton] = useState<HTMLButtonElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // DMs and group DMs are answered in the conversation; channels and threads in the thread.
  const replyThreadTs = isThread ? latest.threadTs : (latest.channelKind === 'dm' || latest.channelKind === 'group') ? '' : latest.ts;
  const replyWhere = replyThreadTs ? 'in the thread' : 'in the conversation';
  const hidden = showAll ? 0 : Math.max(0, messages.length - COLLAPSED_COUNT);
  const visible = messages.slice(hidden);
  // Consecutive messages from the same person form one turn.
  const runs: SlackMention[][] = [];
  for (const message of visible) {
    const last = runs[runs.length - 1];
    if (last && (last[0].authorId ?? last[0].author) === (message.authorId ?? message.author)) last.push(message);
    else runs.push([message]);
  }

  useEffect(() => {
    if (replying) textareaRef.current?.focus();
  }, [replying]);

  useEffect(() => {
    if (sendAt === null) return undefined;
    const timer = window.setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= sendAt) {
        window.clearInterval(timer);
        setSendAt(null);
        setBusy('send');
        workApi.slackReply(projectPath, latest.id, replyThreadTs, draft.trim(), otherIds)
          .then(() => onClosed(conversation, 'replied'))
          .catch((e: Error) => {
            setError(e.message);
            setBusy(null);
          });
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [conversation, draft, latest.id, onClosed, otherIds, projectPath, replyThreadTs, sendAt]);

  // Any reaction (on the newest message) answers the whole conversation, except 👀.
  const react = async (name: string, char: string | null) => {
    setPickerOpen(false);
    if (OPEN_REACTIONS.has(name) && latest.myReactions.includes(name)) return;
    setBusy('done');
    setError(null);
    try {
      await workApi.slackDone(projectPath, latest.id, true, name, OPEN_REACTIONS.has(name) ? [] : otherIds);
      recordEmojiUse(name, char);
      if (OPEN_REACTIONS.has(name)) {
        onReacted({ ...latest, myReactions: [...latest.myReactions, name] });
        setBusy(null);
      } else {
        onClosed(conversation, 'done', { name, char });
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const resolve = async () => {
    setResolving(true);
    setError(null);
    try {
      await workApi.resolve(projectPath, 'slack', messages.map((m) => m.id), true);
      onClosed(conversation, 'resolved');
    } catch (e) {
      setError((e as Error).message);
      setResolving(false);
    }
  };

  const draftWithAi = async () => {
    setDrafting(true);
    setError(null);
    try {
      const context = isThread ? undefined : messages.map((m) => `${m.author}: ${m.text}`);
      const { text } = await workApi.slackAiReply(projectPath, latest.id, latest.threadTs, latest.author, draft, context);
      setDraft(text);
      setAiMode(false);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (aiMode) {
        if (!drafting) void draftWithAi();
        return;
      }
      if (draft.trim()) setSendAt(Date.now() + SEND_DELAY_MS);
    } else if (event.key === 'Escape') {
      setReplying(false);
    }
  };

  const secondsLeft = sendAt ? Math.max(0, Math.ceil((sendAt - Date.now()) / 1000)) : 0;
  const button = 'inline-flex h-6 items-center gap-1 rounded border border-border/70 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50';

  return (
    <li className="group flex gap-2.5 px-1 py-2.5">
      {messages.length === 1 && <Avatar mention={latest} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {isNew && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="New since you last looked" />}
          <span className="truncate font-semibold text-foreground">{authors.map((a) => a.author).join(', ')}</span>
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <ChannelIcon kind={latest.channelKind} />
            <span className="truncate">{latest.channelName}</span>
          </span>
          {isThread && <span className="shrink-0 rounded bg-muted px-1">thread</span>}
          {messages.length > 1 && <span className="shrink-0">· {messages.length} messages</span>}
          <span className="shrink-0">· {slackTimeAgo(latest.ts)}</span>
          {latest.myReactions.includes('eyes') && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-sky-500/15 px-1 text-sky-700 dark:text-sky-300" title="You reacted 👀">
              <Eye className="h-3 w-3" /> on it
            </span>
          )}
          <a href={latest.permalink} target="_blank" rel="noreferrer" className="ml-auto shrink-0 hover:text-primary" title="Open in Slack">
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {hidden > 0 && (
          <button type="button" onClick={() => setShowAll(true)} className="mt-1 text-[11px] font-medium text-primary hover:underline">
            Show {hidden} earlier message{hidden > 1 ? 's' : ''}
          </button>
        )}
        {messages.length === 1 ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
            {latest.text || <span className="italic text-muted-foreground">No text (attachment or bot card), open it in Slack.</span>}
          </p>
        ) : (
          // Slack-style: each speaker's turn has their face, name and time, then their messages.
          <ul className="mt-1.5 space-y-2">
            {runs.map((run) => (
              <li key={run[0].id} className="flex gap-2">
                <Avatar mention={run[0]} size="h-7 w-7" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[13px] font-semibold text-foreground">{run[0].author}</span>
                    <span className="text-[10px] text-muted-foreground">{clockTime(run[0].ts)}</span>
                  </div>
                  {run.map((message) => (
                    <p key={message.id} className="whitespace-pre-wrap break-words text-sm leading-snug">
                      {message.text || <span className="italic text-muted-foreground">No text (attachment or bot card)</span>}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}

        {replying && (
          <div className="mt-2 rounded-md border border-border/70 bg-background focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={sendAt !== null || busy === 'send' || drafting}
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              placeholder={aiMode
                ? 'What should the reply say? (Enter to draft; empty lets Claude decide)'
                : `Reply ${replyWhere} as you… (Enter to send, Shift+Enter for a new line)`}
              className="block w-full resize-none bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
            />
            <div className="flex items-center gap-2 border-t border-border/50 px-2 py-1 text-[11px] text-muted-foreground">
              {sendAt !== null ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Sending in {secondsLeft}s
                  <button type="button" onClick={() => setSendAt(null)} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent">
                    <Undo2 className="h-3 w-3" /> Cancel
                  </button>
                </>
              ) : busy === 'send' ? (
                <><Loader2 className="h-3 w-3 animate-spin" /> Sending…</>
              ) : drafting ? (
                <><Loader2 className="h-3 w-3 animate-spin" /> Claude is drafting your reply…</>
              ) : aiMode ? (
                <>
                  <Sparkles className="h-3 w-3" /> Claude reads the conversation and drafts it in your voice
                  <button type="button" onClick={() => setAiMode(false)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">Write it myself</button>
                  <button type="button" onClick={() => void draftWithAi()} className="inline-flex items-center gap-1 rounded bg-violet-600 px-2 py-0.5 font-medium text-white hover:bg-violet-600/90">
                    <Sparkles className="h-3 w-3" /> Draft
                  </button>
                </>
              ) : (
                <>
                  <CornerDownLeft className="h-3 w-3" /> posts {replyWhere} as you
                  <button type="button" onClick={() => setReplying(false)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">Close</button>
                  <button
                    type="button"
                    onClick={() => void draftWithAi()}
                    title="Rewrite what you typed in your voice (or draft one if empty)"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-violet-600 hover:bg-violet-500/10 dark:text-violet-400"
                  >
                    <Sparkles className="h-3 w-3" /> Polish
                  </button>
                  <button
                    type="button"
                    disabled={!draft.trim()}
                    onClick={() => setSendAt(Date.now() + SEND_DELAY_MS)}
                    className="inline-flex items-center gap-1 rounded bg-primary px-2 py-0.5 font-medium text-primary-foreground disabled:opacity-50"
                  >
                    <Send className="h-3 w-3" /> Send
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}

        <div className="mt-1.5 flex flex-wrap items-center gap-1 opacity-100 transition-opacity sm:opacity-60 sm:group-hover:opacity-100">
          <SessionButton seed={conversationSeed(conversation)} actions={sessions} />
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => void react('white_check_mark', '✅')}
            disabled={busy !== null}
            className={cn(button, 'hover:border-emerald-500/50 hover:text-emerald-600')}
            title={messages.length > 1 ? 'React ✅ on the newest message; closes the whole conversation' : 'React ✅ as you'}
          >
            {busy === 'done' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Done
          </button>
          <button
            ref={setReactButton}
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            disabled={busy !== null}
            aria-label="Add a reaction"
            aria-expanded={pickerOpen}
            title="React on the newest message (👍 🔥 💯…). Any reaction but 👀 closes the conversation here."
            className={cn(button, 'px-1.5', pickerOpen && 'bg-accent text-foreground')}
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </button>
          {pickerOpen && <EmojiPicker anchor={reactButton} onPick={(name, char) => void react(name, char)} onClose={() => setPickerOpen(false)} />}
          {!replying && (
            <>
              <button type="button" onClick={() => setReplying(true)} className={button} title={`Reply ${replyWhere}`}>
                <Reply className="h-3 w-3" /> Reply
              </button>
              <button
                type="button"
                onClick={() => {
                  setReplying(true);
                  setAiMode(true);
                  setDraft('');
                }}
                className={cn(button, 'hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400')}
                title="Tell Claude what to say; it reads the conversation and drafts the reply in your voice"
              >
                <Sparkles className="h-3 w-3" /> AI reply
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void resolve()}
            disabled={resolving || busy !== null}
            className={cn(button, 'ml-auto border-transparent')}
            title="Hide this conversation here only. Nothing is sent or added in Slack."
          >
            {resolving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />} Resolve
          </button>
        </div>
      </div>
    </li>
  );
}

/** Slack messages that tag or DM the user and still need them: no reaction from them (👀 aside) and no reply. */
export default function SlackSection({
  projectPath,
  mentions,
  resolved,
  newKeys,
  error,
  sessions,
  onChange,
}: {
  projectPath: string;
  mentions: SlackMention[];
  resolved: SlackMention[];
  newKeys: Set<string>;
  error: string | null;
  sessions: SessionActions;
  onChange: (next: { mentions: SlackMention[]; resolved: SlackMention[] }) => void;
}) {
  const [closed, setClosed] = useState<Closed[]>([]);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const byNewest = (list: SlackMention[]) => [...list].sort((a, b) => Number(b.ts) - Number(a.ts));

  const setResolved = async (items: SlackMention[], resolvedNow: boolean) => {
    const ids = new Set(items.map((m) => m.id));
    const previous = { mentions, resolved };
    onChange(resolvedNow
      ? { mentions: mentions.filter((m) => !ids.has(m.id)), resolved: byNewest([...resolved.filter((m) => !ids.has(m.id)), ...items]) }
      : { mentions: byNewest([...mentions.filter((m) => !ids.has(m.id)), ...items]), resolved: resolved.filter((m) => !ids.has(m.id)) });
    try {
      await workApi.resolve(projectPath, 'slack', [...ids], resolvedNow);
    } catch (e) {
      setUndoError((e as Error).message);
      onChange(previous);
    }
  };

  // Kvn: everything resolved at once can be brought back in one click for a few seconds.
  const [bulkResolved, setBulkResolved] = useState<{ items: SlackMention[]; at: number } | null>(null);
  const resolveAll = async () => {
    const items = mentions;
    setBulkBusy(true);
    await setResolved(items, true);
    setBulkBusy(false);
    setBulkResolved({ items, at: Date.now() });
  };
  useEffect(() => {
    if (!bulkResolved) return undefined;
    const timer = window.setTimeout(() => setBulkResolved(null), UNDO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [bulkResolved]);

  useEffect(() => {
    if (closed.length === 0) return undefined;
    const timer = window.setInterval(() => {
      setClosed((list) => list.filter((c) => Date.now() - c.at < UNDO_WINDOW_MS));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [closed.length]);

  const conversations = useMemo(() => groupConversations(mentions), [mentions]);

  const onClosed = (conversation: Conversation, how: Closed['how'], reaction?: Reaction) => {
    const ids = new Set(conversation.messages.map((m) => m.id));
    onChange({
      mentions: mentions.filter((m) => !ids.has(m.id)),
      resolved: how === 'resolved' ? byNewest([...conversation.messages, ...resolved]) : resolved,
    });
    setClosed((list) => [
      ...list.filter((c) => c.conversation.key !== conversation.key),
      { conversation, how, at: Date.now(), reaction },
    ]);
  };

  const onReacted = (mention: SlackMention) => {
    onChange({ mentions: mentions.map((m) => (m.id === mention.id ? mention : m)), resolved });
  };

  const undoDone = async (entry: Closed) => {
    setClosed((list) => list.filter((c) => c !== entry));
    try {
      const { latest, messages } = entry.conversation;
      if (entry.how === 'resolved') {
        await setResolved(messages, false);
        return;
      }
      const others = messages.filter((m) => m.id !== latest.id).map((m) => m.id);
      await workApi.slackDone(projectPath, latest.id, false, entry.reaction?.name, others);
      onChange({ mentions: byNewest([...messages, ...mentions]), resolved });
    } catch (e) {
      setUndoError((e as Error).message);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-2 px-1 pb-1.5 pt-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Slack · needs you
          <span className="ml-1 font-normal normal-case text-muted-foreground/70" title={`${mentions.length} message${mentions.length === 1 ? '' : 's'}`}>
            · {conversations.length}{conversations.length !== mentions.length ? ` (${mentions.length} msgs)` : ''}
          </span>
        </h3>
        {mentions.length > 0 && (
          <button
            type="button"
            onClick={() => void resolveAll()}
            disabled={bulkBusy}
            title="Move all of these to Resolved, here only. Nothing is sent or added in Slack."
            className="ml-auto inline-flex h-6 items-center gap-1 rounded border border-border/70 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {bulkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
            Resolve all{mentions.length > 1 ? ` (${mentions.length})` : ''}
          </button>
        )}
      </div>
      {bulkResolved && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Resolved {bulkResolved.items.length} message{bulkResolved.items.length > 1 ? 's' : ''}
          </span>
          <button
            type="button"
            onClick={() => {
              const { items } = bulkResolved;
              setBulkResolved(null);
              void setResolved(items, false);
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20"
          >
            <Undo2 className="h-3 w-3" /> Undo
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">Slack could not load: {error}</span>
        </div>
      )}
      {undoError && <p className="px-1 text-xs text-destructive">{undoError}</p>}

      {closed.length > 0 && (
        <ul className="mb-2 space-y-1">
          {closed.map((entry) => (
            <li key={entry.conversation.key} className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {entry.how === 'done' ? `${entry.reaction?.char ?? (entry.reaction ? `:${entry.reaction.name}:` : '✅')} added on` : entry.how === 'resolved' ? 'Resolved' : 'Replied to'} {authorsOf(entry.conversation).map((m) => m.author).join(', ')}{entry.conversation.messages.length > 1 ? ` (${entry.conversation.messages.length} messages)` : "'s message"}
              </span>
              {entry.how !== 'replied' ? (
                <button type="button" onClick={() => void undoDone(entry)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20">
                  <Undo2 className="h-3 w-3" /> Undo
                </button>
              ) : (
                <a href={entry.conversation.latest.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20">
                  <ExternalLink className="h-3 w-3" /> Thread
                </a>
              )}
              <button type="button" aria-label="Dismiss" onClick={() => setClosed((list) => list.filter((c) => c !== entry))} className="rounded p-0.5 hover:bg-emerald-500/20">
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="divide-y divide-border/50">
        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.key}
            conversation={conversation}
            isNew={conversation.messages.some((m) => newKeys.has(`slack:${m.id}`))}
            projectPath={projectPath}
            sessions={sessions}
            onClosed={onClosed}
            onReacted={onReacted}
          />
        ))}
      </ul>
      {!error && mentions.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">Inbox zero: nothing on Slack is waiting on you.</p>}

      {resolved.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="flex items-center gap-1 px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            {showResolved ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Resolved
            <span className="font-normal normal-case text-muted-foreground/70">· {resolved.length}</span>
          </button>
          {showResolved && (
            <ul className="divide-y divide-border/40">
              {resolved.map((mention) => (
                <li key={mention.id} className="flex items-center gap-2 px-1 py-1.5 text-muted-foreground">
                  <Avatar mention={mention} size="h-5 w-5" />
                  <span className="shrink-0 text-xs font-medium text-foreground/80">{mention.author}</span>
                  <a href={mention.permalink} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-xs hover:text-foreground hover:underline">
                    {mention.text || 'open in Slack'}
                  </a>
                  <span className="shrink-0 text-[11px]">{slackTimeAgo(mention.ts)}</span>
                  <button
                    type="button"
                    onClick={() => void setResolved([mention], false)}
                    title="Show it in the list again"
                    className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-foreground"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
