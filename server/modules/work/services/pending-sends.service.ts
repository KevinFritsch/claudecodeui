/**
 * Kvn: Slack sends wait a few seconds so a wrong message can still be pulled
 * back. The wait runs here, not in the browser, so leaving the Work view (or
 * closing the tab) no longer drops the message: it goes out anyway.
 */
import crypto from 'node:crypto';

export type PendingSendState = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

export type PendingSendView = {
  id: string;
  projectPath: string;
  /** What the UI shows ("Reply to James", "DM to Nick"). */
  label: string;
  /** The Slack message it answers, when it is a reply. */
  itemId: string | null;
  sendAt: number;
  state: PendingSendState;
  error: string | null;
  /** Extra word on how it went out (e.g. the connector footer). */
  note: string | null;
};

type PendingSend = PendingSendView & {
  timer: NodeJS.Timeout | null;
  finishedAt: number | null;
  dismissed: boolean;
};

export const MAX_SEND_DELAY_MS = 15_000;
const KEEP_FINISHED_MS = 30 * 60_000;
const sends = new Map<string, PendingSend>();

function view(send: PendingSend): PendingSendView {
  const { timer: _timer, finishedAt: _finishedAt, dismissed: _dismissed, ...rest } = send;
  return rest;
}

function prune(now = Date.now()): void {
  for (const [id, send] of sends) {
    if (send.finishedAt !== null && now - send.finishedAt > KEEP_FINISHED_MS) sends.delete(id);
  }
}

export function scheduleSend(
  input: { projectPath: string; label: string; itemId?: string | null; delayMs: number },
  run: () => Promise<unknown>,
): PendingSendView {
  prune();
  const delayMs = Math.max(0, Math.min(MAX_SEND_DELAY_MS, Math.round(input.delayMs)));
  const send: PendingSend = {
    id: crypto.randomUUID(),
    projectPath: input.projectPath,
    label: input.label.slice(0, 160),
    itemId: input.itemId ?? null,
    sendAt: Date.now() + delayMs,
    state: 'pending',
    error: null,
    note: null,
    timer: null,
    finishedAt: null,
    dismissed: false,
  };
  send.timer = setTimeout(() => {
    send.timer = null;
    if (send.state !== 'pending') return;
    send.state = 'sending';
    run()
      .then((result) => {
        send.state = 'sent';
        const note = (result as { note?: unknown } | null)?.note;
        if (typeof note === 'string') send.note = note;
      })
      .catch((error: unknown) => {
        send.state = 'failed';
        send.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        send.finishedAt = Date.now();
      });
  }, delayMs);
  sends.set(send.id, send);
  return view(send);
}

/** Cancels a send that has not gone out yet; returns its state either way. */
export function cancelSend(id: string): PendingSendView | null {
  const send = sends.get(id);
  if (!send) return null;
  if (send.state === 'pending') {
    if (send.timer) clearTimeout(send.timer);
    send.timer = null;
    send.state = 'cancelled';
    send.finishedAt = Date.now();
    send.dismissed = true;
  }
  return view(send);
}

export function getSend(id: string): PendingSendView | null {
  const send = sends.get(id);
  return send ? view(send) : null;
}

/** Sends still waiting, and failures not dismissed yet, for one project. */
export function listSends(projectPath: string): PendingSendView[] {
  prune();
  return [...sends.values()]
    .filter((s) => s.projectPath === projectPath && !s.dismissed && (s.state === 'pending' || s.state === 'sending' || s.state === 'failed'))
    .sort((a, b) => a.sendAt - b.sendAt)
    .map(view);
}

export function dismissSend(id: string): boolean {
  const send = sends.get(id);
  if (!send || send.state === 'pending' || send.state === 'sending') return false;
  send.dismissed = true;
  return true;
}
