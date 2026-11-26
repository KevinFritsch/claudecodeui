import { AlertTriangle, Loader2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { workApi, type PendingSend } from '@/modules/work/api';
import { PENDING_SENDS_CHANGED_EVENT, liveSendIds } from '@/modules/work/useDelayedSend';

/**
 * Kvn: Slack sends started elsewhere (a closed reply box, another tab) that are
 * still counting down, plus any that failed, so nothing goes out or gets lost
 * without you seeing it.
 */
export default function PendingSends({ projectPath, onSent }: { projectPath: string; onSent?: () => void }) {
  const [sends, setSends] = useState<PendingSend[]>([]);
  const [, tick] = useState(0);
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;

  const load = useCallback(() => {
    workApi.pendingSends(projectPath)
      .then(({ sends: next }) => {
        setSends((previous) => {
          // One that was waiting here and is gone now went out.
          if (onSentRef.current && previous.some((p) => p.state !== 'failed' && !next.some((n) => n.id === p.id))) onSentRef.current();
          return next;
        });
      })
      .catch(() => undefined);
  }, [projectPath]);

  useEffect(() => {
    load();
    window.addEventListener(PENDING_SENDS_CHANGED_EVENT, load);
    return () => window.removeEventListener(PENDING_SENDS_CHANGED_EVENT, load);
  }, [load]);

  const waiting = sends.some((s) => s.state === 'pending' || s.state === 'sending');
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(() => {
      tick((n) => n + 1);
      load();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  const shown = sends.filter((s) => !liveSendIds.has(s.id));
  if (shown.length === 0) return null;

  return (
    <div className="space-y-1">
      {shown.map((send) => (
        send.state === 'failed' ? (
          <div key={send.id} className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Not sent: {send.label}{send.error ? ` (${send.error})` : ''}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => void workApi.dismissSend(send.id).then(load)}
              className="rounded p-0.5 hover:bg-destructive/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div key={send.id} className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 truncate">
              {send.state === 'sending' || Date.now() >= send.sendAt
                ? `Sending: ${send.label}…`
                : `${send.label}: sending in ${Math.max(1, Math.ceil((send.sendAt - Date.now()) / 1000))}s`}
            </span>
            {send.state === 'pending' && (
              <button
                type="button"
                onClick={() => void workApi.cancelSend(send.id).then(load)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent"
              >
                <Undo2 className="h-3 w-3" /> Cancel
              </button>
            )}
          </div>
        )
      ))}
    </div>
  );
}
