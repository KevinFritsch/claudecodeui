import { useCallback, useEffect, useRef, useState } from 'react';

import { workApi, type PendingSend } from '@/modules/work/api';

export const SEND_DELAY_MS = 5_000;
export const PENDING_SENDS_CHANGED_EVENT = 'kvn:pending-sends-changed';

/** Sends a mounted countdown is showing; the Work strip lists only the others. */
export const liveSendIds = new Set<string>();

type Handlers = { onSent: (send: PendingSend) => void; onFailed: (message: string) => void };

/**
 * Kvn: the "Sending in 5s · Cancel" countdown. The wait itself runs on the
 * server, so the message still goes out if this view is left or closed; this
 * hook only shows the countdown, offers Cancel and reports the outcome.
 */
export function useDelayedSend() {
  const [state, setState] = useState<{ id: string | null; sendAt: number; sending: boolean } | null>(null);
  const [, tick] = useState(0);
  const handlers = useRef<Handlers | null>(null);
  const cancelRequested = useRef(false);

  const finish = useCallback((send: PendingSend | null, error?: string) => {
    window.dispatchEvent(new Event(PENDING_SENDS_CHANGED_EVENT));
    const current = handlers.current;
    setState(null);
    if (!current) return;
    if (error) current.onFailed(error);
    else if (send?.state === 'sent') current.onSent(send);
    else if (send?.state === 'failed') current.onFailed(send.error || 'Slack did not accept the message.');
  }, []);

  const start = useCallback(async (queue: (delayMs: number) => Promise<PendingSend | undefined>, next: Handlers) => {
    handlers.current = next;
    cancelRequested.current = false;
    const sendAt = Date.now() + SEND_DELAY_MS;
    setState({ id: null, sendAt, sending: false });
    try {
      const pending = await queue(SEND_DELAY_MS);
      if (!pending) {
        finish({ state: 'sent' } as PendingSend);
        return;
      }
      window.dispatchEvent(new Event(PENDING_SENDS_CHANGED_EVENT));
      if (cancelRequested.current) {
        const result = await workApi.cancelSend(pending.id);
        if (result.state === 'cancelled') {
          setState(null);
          window.dispatchEvent(new Event(PENDING_SENDS_CHANGED_EVENT));
          return;
        }
      }
      setState({ id: pending.id, sendAt, sending: false });
    } catch (e) {
      finish(null, (e as Error).message);
    }
  }, [finish]);

  // Countdown, then ask the server how it went.
  useEffect(() => {
    if (!state) return undefined;
    const timer = window.setInterval(() => {
      tick((n) => n + 1);
      if (!state.id || Date.now() < state.sendAt) return;
      workApi.pendingSend(state.id)
        .then((send) => {
          if (send.state === 'sent' || send.state === 'failed' || send.state === 'cancelled') finish(send);
          else if (!state.sending) setState((s) => (s ? { ...s, sending: true } : s));
        })
        .catch(() => undefined);
    }, 400);
    return () => window.clearInterval(timer);
  }, [state, finish]);

  const liveId = state?.id ?? null;
  useEffect(() => {
    if (!liveId) return undefined;
    liveSendIds.add(liveId);
    return () => {
      liveSendIds.delete(liveId);
      // Hand the countdown over to the Work strip.
      window.dispatchEvent(new Event(PENDING_SENDS_CHANGED_EVENT));
    };
  }, [liveId]);

  // Leaving the view does not cancel anything; the handlers just stop applying.
  useEffect(() => () => {
    handlers.current = null;
  }, []);

  const cancel = useCallback(async () => {
    if (!state) return;
    if (!state.id) {
      cancelRequested.current = true;
      return;
    }
    try {
      const result = await workApi.cancelSend(state.id);
      if (result.state === 'cancelled') {
        setState(null);
        window.dispatchEvent(new Event(PENDING_SENDS_CHANGED_EVENT));
      } else {
        finish(result);
      }
    } catch (e) {
      finish(null, (e as Error).message);
    }
  }, [state, finish]);

  return {
    active: state !== null,
    sending: Boolean(state && (state.sending || Date.now() >= state.sendAt)),
    secondsLeft: state ? Math.max(0, Math.ceil((state.sendAt - Date.now()) / 1000)) : 0,
    start,
    cancel,
  };
}
