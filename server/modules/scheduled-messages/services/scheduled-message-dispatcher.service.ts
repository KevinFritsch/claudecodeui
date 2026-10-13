import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;
// Queued turns ("will send when this finishes") are checked far more often
// than scheduled ones, and also right after any run completes.
const QUEUED_POLL_INTERVAL_MS = 3_000;
let queuedPollTimer: ReturnType<typeof setInterval> | null = null;
let queuedDispatchInFlight = false;
let queuedDispatchAgain = false;
let unsubscribeRunCompleted: (() => void) | null = null;
let dispatcherRuntime: ProviderRuntimeGateway | null = null;

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  if (!result.started && result.error === 'A run was already in progress for this session.') {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Whether a queued turn has to keep waiting for the session.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) is marked completed, but its CLI process stays open so
 * that work can report back. A new turn replaces that process and stops the
 * work, which is why the composer asks before an interactive send. A queued
 * turn was promised to go "when this finishes", so it waits for that work too.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId);
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, runtime);
  }));

  return claimed;
}

/**
 * Runs one queued-message pass, never two at once; a request that arrives
 * while a pass is running schedules exactly one more pass after it.
 */
function triggerQueuedDispatch(runtime: ProviderRuntimeGateway): void {
  if (queuedDispatchInFlight) {
    queuedDispatchAgain = true;
    return;
  }
  queuedDispatchInFlight = true;
  void dispatchQueuedMessages(runtime)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ScheduledMessages] Queued dispatch failed', { error: message });
    })
    .finally(() => {
      queuedDispatchInFlight = false;
      if (queuedDispatchAgain) {
        queuedDispatchAgain = false;
        triggerQueuedDispatch(runtime);
      }
    });
}

/**
 * "Send now" on a queued turn: takes the session's queued message (the stored
 * one, or the content the client sent if its copy has not synced yet) and
 * starts it immediately, interrupting the run in progress.
 */
export async function sendQueuedMessageNow(
  input: { userId: number; sessionId: string; fallback: unknown },
  runtime: ProviderRuntimeGateway | null = dispatcherRuntime,
): Promise<{ started: boolean; error: string | null }> {
  if (!runtime) {
    return { started: false, error: 'The dispatcher is not running.' };
  }
  const candidate = sessionDraftsDb.listQueuedMessages()
    .find((row) => row.userId === input.userId && row.sessionId === input.sessionId) ?? null;
  const claimed = candidate && sessionDraftsDb.claimQueuedMessage(candidate) ? candidate : null;
  const message = readQueuedMessage(claimed ? claimed.queuedMessage : input.fallback);
  if (!message) {
    return { started: false, error: 'There is no queued message for this session.' };
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: input.sessionId,
      userId: input.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
      interruptActiveRun: true,
    },
    { runtime },
  );
  if (!result.started && claimed) {
    // Nothing was sent: keep the message queued rather than losing it.
    sessionDraftsDb.restoreQueuedMessage(claimed);
  } else {
    sessionDraftsDb.deleteEmptyDraft(input.userId, input.sessionId);
  }
  return result;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  dispatcherRuntime = runtime;
  // A queued turn goes as soon as the run it waits on ends; the short poll
  // covers background work that finishes after the run itself.
  unsubscribeRunCompleted = chatRunRegistry.onRunCompleted(() => triggerQueuedDispatch(runtime));
  queuedPollTimer = setInterval(() => triggerQueuedDispatch(runtime), QUEUED_POLL_INTERVAL_MS);
  queuedPollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (queuedPollTimer) {
    clearInterval(queuedPollTimer);
    queuedPollTimer = null;
  }
  unsubscribeRunCompleted?.();
  unsubscribeRunCompleted = null;
  dispatcherRuntime = null;
}
