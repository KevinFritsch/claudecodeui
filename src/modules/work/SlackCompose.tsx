import { Check, Hash, Loader2, MessageCircle, NotebookPen, PenLine, Send, Sparkles, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '@/shared/utils';
import { workApi, type ComposePreview, type ComposeTarget } from '@/modules/work/api';

const SEND_DELAY_MS = 5_000;

type Stage =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'review'; preview: ComposePreview }
  | { kind: 'done'; message: string };

/**
 * Kvn: write a Slack message in plain words ("ask James if we replace the day
 * 10 prize, it's out of stock"). Claude finds the person or channel, any
 * thread it continues, and cleans the text up in your voice; you review it and
 * choose Draft (saved in Slack for later) or Send (posted as you).
 */
export default function SlackCompose({ projectPath }: { projectPath: string }) {
  const [instruction, setInstruction] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [targetId, setTargetId] = useState<string>('');
  const [threadTs, setThreadTs] = useState<string>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'draft' | 'send' | null>(null);
  const [sendAt, setSendAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const prepare = async () => {
    if (!instruction.trim()) return;
    setError(null);
    setStage({ kind: 'preparing' });
    try {
      const preview = await workApi.composePrepare(projectPath, instruction);
      setTargetId(preview.target?.id ?? '');
      setThreadTs(preview.suggestedThreadTs ?? '');
      setText(preview.text);
      setStage({ kind: 'review', preview });
      window.setTimeout(() => textRef.current?.focus(), 0);
    } catch (e) {
      setError((e as Error).message);
      setStage({ kind: 'idle' });
    }
  };

  const preview = stage.kind === 'review' ? stage.preview : null;
  const thread = preview?.threads.find((t) => t.ts === threadTs) ?? null;
  const recipient: ComposeTarget | null = thread
    ? thread.channel
    : preview?.directory.find((t) => t.id === targetId) ?? null;
  const destinationLabel = thread
    ? `thread in ${thread.channel.label}`
    : recipient
      ? (recipient.kind === 'dm' ? `DM to ${recipient.label.replace(/\s*\(@.*\)$/, '')}` : recipient.label)
      : null;

  const deliver = async (mode: 'draft' | 'send') => {
    if (!recipient || !text.trim()) return;
    setBusy(mode);
    setError(null);
    try {
      await workApi.composeDeliver(projectPath, { mode, target: recipient, threadTs: thread?.ts ?? null, text });
      setStage({ kind: 'done', message: mode === 'draft' ? `Draft saved in Slack (${destinationLabel})` : `Sent: ${destinationLabel}` });
      setInstruction('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Sending waits a few seconds so a wrong recipient can still be pulled back.
  useEffect(() => {
    if (sendAt === null) return undefined;
    const timer = window.setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= sendAt) {
        window.clearInterval(timer);
        setSendAt(null);
        void deliver('send');
      }
    }, 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendAt]);

  const reset = () => {
    setStage({ kind: 'idle' });
    setError(null);
    setSendAt(null);
  };

  const onInstructionKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void prepare();
    }
  };

  const secondsLeft = sendAt ? Math.max(0, Math.ceil((sendAt - Date.now()) / 1000)) : 0;

  return (
    <section className="rounded-lg border border-border/70 bg-muted/20 p-2.5">
      {stage.kind !== 'review' && (
        <>
          <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <PenLine className="h-3.5 w-3.5" /> Write a message
          </div>
          {stage.kind === 'done' && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-800 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{stage.message}</span>
              <button type="button" onClick={reset} aria-label="Dismiss" className="rounded p-0.5 hover:bg-emerald-500/20">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={onInstructionKey}
            disabled={stage.kind === 'preparing'}
            rows={Math.min(5, Math.max(2, instruction.split('\n').length))}
            placeholder={'e.g. "ask James if we should replace the day 10 Press Your Luck prize, it\'s out of stock" or "reply to Jade in the apple watch thread that it\'s in 1.48"'}
            className="block w-full resize-none rounded-md border border-border/70 bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-1 focus:ring-primary/30 disabled:opacity-60"
          />
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">Who, what, and which thread if any. Nothing is sent before you review it.</span>
            <button
              type="button"
              onClick={() => void prepare()}
              disabled={!instruction.trim() || stage.kind === 'preparing'}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {stage.kind === 'preparing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {stage.kind === 'preparing' ? 'Preparing…' : 'Prepare'}
            </button>
          </div>
        </>
      )}

      {preview && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">To</span>
            <select
              value={thread ? '' : targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setThreadTs('');
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 text-xs"
            >
              {thread && <option value="">{destinationLabel}</option>}
              {!recipient && !thread && <option value="">Pick a person or channel…</option>}
              <optgroup label="People">
                {preview.directory.filter((t) => t.kind === 'dm').map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </optgroup>
              <optgroup label="Channels">
                {preview.directory.filter((t) => t.kind === 'channel').map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </optgroup>
            </select>
            <button type="button" onClick={reset} title="Start over" aria-label="Start over" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {preview.note && <p className="text-[11px] text-amber-700 dark:text-amber-400">{preview.note}</p>}

          {preview.threads.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reply in</div>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent/50">
                <input type="radio" name="compose-thread" checked={!threadTs} onChange={() => setThreadTs('')} className="mt-0.5" />
                <span>A new message {recipient && !thread ? `(${recipient.kind === 'dm' ? 'DM' : recipient.label})` : ''}</span>
              </label>
              {preview.threads.map((t) => (
                <label key={t.ts} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent/50">
                  <input type="radio" name="compose-thread" checked={threadTs === t.ts} onChange={() => setThreadTs(t.ts)} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      {t.channel.kind === 'dm' ? <MessageCircle className="h-3 w-3" /> : <Hash className="h-3 w-3" />}
                      {t.channel.label} · {t.author}
                    </span>
                    <span className="block truncate text-foreground/90">{t.text}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy !== null || sendAt !== null}
            rows={Math.min(8, Math.max(3, text.split('\n').length + 1))}
            className="block w-full resize-none rounded-md border border-border/70 bg-background px-2.5 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 disabled:opacity-60"
          />

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {sendAt !== null ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Sending to {destinationLabel} in {secondsLeft}s
                <button type="button" onClick={() => setSendAt(null)} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent">
                  <Undo2 className="h-3 w-3" /> Cancel
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">{destinationLabel ? `→ ${destinationLabel}` : 'Pick a recipient'}</span>
                <button
                  type="button"
                  onClick={() => void deliver('draft')}
                  disabled={!recipient || !text.trim() || busy !== null}
                  title="Save it as a draft in Slack, to send from there"
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 px-2.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                >
                  {busy === 'draft' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <NotebookPen className="h-3.5 w-3.5" />} Draft
                </button>
                <button
                  type="button"
                  onClick={() => setSendAt(Date.now() + SEND_DELAY_MS)}
                  disabled={!recipient || !text.trim() || busy !== null}
                  className={cn('inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground disabled:opacity-50')}
                >
                  {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
