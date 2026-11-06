import { AlertTriangle, Check, CornerDownLeft, ExternalLink, Eye, Hash, Loader2, Lock, MessageCircle, Reply, Send, Undo2, Users, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '@/shared/utils';
import { workApi, type SlackMention } from '@/modules/work/api';
import { SessionButton, clip, type SessionActions, type SessionSeed } from '@/modules/work/SessionButton';

const SEND_DELAY_MS = 5_000;
const UNDO_WINDOW_MS = 8_000;

function slackTimeAgo(ts: string): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - Number(ts)));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function slackSeed(mention: SlackMention): SessionSeed {
  const where = mention.channelKind === 'dm' ? 'a DM' : `#${mention.channelName}`;
  const quoted = (mention.text || '(no text, open the link)').split('\n').map((line) => `> ${line}`).join('\n');
  return {
    itemType: 'slack',
    itemKey: mention.id,
    sessionName: clip(`slack: ${mention.author} ${mention.text}`, 80),
    prompt: [
      `slack: ${mention.author} in ${where}`,
      mention.permalink,
      '',
      quoted,
      '',
      'Read the whole thread first (Slack connector), then handle this request. When done, draft my reply in the thread (golfn:slack-voice) for me to approve; do not send it.',
      '',
    ].join('\n'),
  };
}

function ChannelIcon({ kind }: { kind: SlackMention['channelKind'] }) {
  const Icon = kind === 'dm' ? MessageCircle : kind === 'group' ? Users : kind === 'private' ? Lock : Hash;
  return <Icon className="h-3 w-3 shrink-0" />;
}

type Closed = { mention: SlackMention; how: 'done' | 'replied'; at: number };

function MentionRow({
  mention,
  projectPath,
  sessions,
  onClosed,
}: {
  mention: SlackMention;
  projectPath: string;
  sessions: SessionActions;
  onClosed: (mention: SlackMention, how: Closed['how']) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [sendAt, setSendAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<'done' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isLong = mention.text.length > 220 || mention.text.split('\n').length > 3;

  useEffect(() => {
    if (replying) textareaRef.current?.focus();
  }, [replying]);

  // The reply goes out after a short countdown, so a typo can still be pulled back.
  useEffect(() => {
    if (sendAt === null) return undefined;
    const timer = window.setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= sendAt) {
        window.clearInterval(timer);
        setSendAt(null);
        setBusy('send');
        workApi.slackReply(projectPath, mention.id, mention.threadTs, draft.trim())
          .then(() => onClosed(mention, 'replied'))
          .catch((e: Error) => {
            setError(e.message);
            setBusy(null);
          });
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [draft, mention, onClosed, projectPath, sendAt]);

  const markDone = async () => {
    setBusy('done');
    setError(null);
    try {
      await workApi.slackDone(projectPath, mention.id, true);
      onClosed(mention, 'done');
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (draft.trim()) setSendAt(Date.now() + SEND_DELAY_MS);
    } else if (event.key === 'Escape') {
      setReplying(false);
    }
  };

  const secondsLeft = sendAt ? Math.max(0, Math.ceil((sendAt - Date.now()) / 1000)) : 0;
  const button = 'inline-flex h-6 items-center gap-1 rounded border border-border/70 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50';

  return (
    <li className="group px-1 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground">{mention.author}</span>
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <ChannelIcon kind={mention.channelKind} />
          <span className="truncate">{mention.channelName}</span>
        </span>
        <span>· {slackTimeAgo(mention.ts)}</span>
        {mention.replyCount > 0 && <span>· {mention.replyCount} repl{mention.replyCount > 1 ? 'ies' : 'y'}</span>}
        {mention.myReactions.includes('eyes') && (
          <span className="inline-flex items-center gap-0.5 rounded bg-sky-500/15 px-1 text-sky-700 dark:text-sky-300" title="You reacted 👀">
            <Eye className="h-3 w-3" /> on it
          </span>
        )}
        <a href={mention.permalink} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-0.5 hover:text-primary" title="Open in Slack">
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <button
        type="button"
        onClick={() => isLong && setExpanded((v) => !v)}
        className={cn('mt-1 block w-full whitespace-pre-wrap break-words text-left text-sm', !expanded && isLong && 'line-clamp-3', !isLong && 'cursor-text')}
      >
        {mention.text || <span className="italic text-muted-foreground">No text (attachment or bot card), open it in Slack.</span>}
      </button>

      {replying && (
        <div className="mt-2 rounded-md border border-border/70 bg-background focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sendAt !== null || busy === 'send'}
            rows={Math.min(6, Math.max(2, draft.split('\n').length))}
            placeholder={`Reply in thread as you… (Enter to send, Shift+Enter for a new line)`}
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
            ) : (
              <>
                <CornerDownLeft className="h-3 w-3" /> posts in the thread as you
                <button type="button" onClick={() => setReplying(false)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground">Close</button>
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
        <SessionButton seed={slackSeed(mention)} actions={sessions} />
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <button type="button" onClick={() => void markDone()} disabled={busy !== null} className={cn(button, 'hover:border-emerald-500/50 hover:text-emerald-600')} title="React ✅ as you">
          {busy === 'done' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Done
        </button>
        {!replying && (
          <button type="button" onClick={() => setReplying(true)} className={button} title="Reply in the thread">
            <Reply className="h-3 w-3" /> Reply
          </button>
        )}
      </div>
    </li>
  );
}

/** Slack messages that tag the user and still need them: not ✅'d and not replied to. */
export default function SlackSection({
  projectPath,
  mentions,
  error,
  sessions,
  onMentionsChange,
}: {
  projectPath: string;
  mentions: SlackMention[];
  error: string | null;
  sessions: SessionActions;
  onMentionsChange: (next: SlackMention[]) => void;
}) {
  const [closed, setClosed] = useState<Closed[]>([]);
  const [undoError, setUndoError] = useState<string | null>(null);

  useEffect(() => {
    if (closed.length === 0) return undefined;
    const timer = window.setInterval(() => {
      setClosed((list) => list.filter((c) => Date.now() - c.at < UNDO_WINDOW_MS));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [closed.length]);

  const onClosed = (mention: SlackMention, how: Closed['how']) => {
    onMentionsChange(mentions.filter((m) => m.id !== mention.id));
    setClosed((list) => [...list.filter((c) => c.mention.id !== mention.id), { mention, how, at: Date.now() }]);
  };

  const undoDone = async (entry: Closed) => {
    setClosed((list) => list.filter((c) => c !== entry));
    try {
      await workApi.slackDone(projectPath, entry.mention.id, false);
      onMentionsChange([entry.mention, ...mentions].sort((a, b) => Number(b.ts) - Number(a.ts)));
    } catch (e) {
      setUndoError((e as Error).message);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-2 px-1 pb-1.5 pt-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Slack · needs you
          <span className="ml-1 font-normal normal-case text-muted-foreground/70">· {mentions.length}</span>
        </h3>
      </div>
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
            <li key={entry.mention.id} className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {entry.how === 'done' ? '✅ added on' : 'Replied to'} {entry.mention.author}'s message
              </span>
              {entry.how === 'done' ? (
                <button type="button" onClick={() => void undoDone(entry)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20">
                  <Undo2 className="h-3 w-3" /> Undo
                </button>
              ) : (
                <a href={entry.mention.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-emerald-500/20">
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
        {mentions.map((mention) => (
          <MentionRow key={mention.id} mention={mention} projectPath={projectPath} sessions={sessions} onClosed={onClosed} />
        ))}
      </ul>
      {!error && mentions.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">Inbox zero: nothing on Slack is waiting on you.</p>}
    </section>
  );
}
