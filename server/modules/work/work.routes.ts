/**
 * HTTP surface of the Work dashboard, mounted at /api/work.
 *
 * Every route takes the project's path (`projectPath`) and only works for
 * projects that have an entry in ~/.config/kvn-work/projects.json.
 */

import express from 'express';
import type { Request, Response } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { transitionIssue } from './services/jira.service.js';
import { linksService, type WorkItemType } from './services/links.service.js';
import { autoLinkPullRequests } from './services/pr-autolink.service.js';
import { resolvedService } from './services/resolved.service.js';
import { seenService } from './services/seen.service.js';
import type { RemoteSnapshot } from './services/snapshot.service.js';
import { draftSlackReply } from './services/ai-reply.service.js';
import { deliverMessage, prepareMessage, type ComposeTarget } from './services/slack-compose.service.js';
import { markDone, postReply, readThread, unmarkDone } from './services/slack.service.js';
import { getSnapshot, markStale, patchSnapshot, warmAllProjects } from './services/snapshot.service.js';
import { todosService, type TodoStatus } from './services/todos.service.js';
import { getProjectConfig, readSecrets, type WorkProjectConfig } from './services/work-config.service.js';

function readProjectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('projectPath is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  return value;
}

function requireConfig(projectPath: string): WorkProjectConfig {
  const config = getProjectConfig(projectPath);
  if (!config) {
    throw new AppError('Work is not set up for this project.', { code: 'WORK_NOT_CONFIGURED', statusCode: 404 });
  }
  return config;
}

const router = express.Router();

warmAllProjects();

/** Which Work sources a project has; `enabled: false` hides the Work tab. */
router.get('/config', (req: Request, res: Response) => {
  const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : '';
  const config = getProjectConfig(projectPath);
  res.json(createApiSuccessResponse({
    enabled: Boolean(config),
    name: config?.name ?? null,
    jira: config?.jira
      ? {
          projectKey: config.jira.projectKey,
          statuses: config.jira.statuses,
          collapsedStatuses: config.jira.collapsedStatuses ?? [],
          actions: config.jira.actions,
        }
      : null,
    bitbucket: config?.bitbucket ? { workspace: config.bitbucket.workspace, repos: config.bitbucket.repos } : null,
    slack: config?.slack ? { lookbackDays: config.slack.lookbackDays ?? 7 } : null,
    todos: Boolean(config?.todos),
  }));
});

/** Everything the dashboard shows. Remote sources are cached for a minute; `refresh=1` skips the cache. */
/** Keys of what can be "new": open Slack mentions (not resolved here) and Jira tasks in the listed statuses. */
function attentionKeys(projectPath: string, config: WorkProjectConfig, snapshot: RemoteSnapshot): string[] {
  const resolvedSlack = resolvedService.keys(projectPath, 'slack');
  const listed = new Set((config.jira?.statuses ?? []).map((s) => s.toLowerCase()));
  return [
    ...(snapshot.slack?.items ?? []).filter((m) => !resolvedSlack.has(m.id)).map((m) => `slack:${m.id}`),
    ...(snapshot.jira?.items ?? []).filter((t) => listed.has(t.status.toLowerCase())).map((t) => `jira:${t.key}`),
  ];
}

/** How many items are new since the user last opened the Work tab; polled by the tab badge. */
router.get('/badge', asyncHandler(async (req: Request, res: Response) => {
  const projectPath = readProjectPath(req.query.projectPath);
  const config = requireConfig(projectPath);
  const { snapshot } = await getSnapshot(projectPath, config);
  res.json(createApiSuccessResponse({ count: seenService.unseen(projectPath, attentionKeys(projectPath, config, snapshot)).length }));
}));

/** Records items as seen (the Work tab was open while they were listed). */
router.post('/seen', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  requireConfig(projectPath);
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string' && k.length < 200).slice(0, 1000) : [];
  if (keys.length > 0) seenService.markSeen(projectPath, keys);
  res.json(createApiSuccessResponse({ count: keys.length }));
}));

router.get('/items', asyncHandler(async (req: Request, res: Response) => {
  const projectPath = readProjectPath(req.query.projectPath);
  const config = requireConfig(projectPath);
  const { snapshot, fetchedAt, refreshing } = await getSnapshot(projectPath, config, { force: req.query.refresh === '1' });
  // Resolved Slack mentions are hidden from the open list but kept, so they can be brought back.
  const resolvedSlack = resolvedService.keys(projectPath, 'slack');
  const slack = snapshot.slack
    ? { ...snapshot.slack, items: snapshot.slack.items.filter((m) => !resolvedSlack.has(m.id)) }
    : null;
  const currentKeys = attentionKeys(projectPath, config, snapshot);
  // Attach PRs to the sessions that opened them (throttled, incremental).
  try {
    autoLinkPullRequests(projectPath, (snapshot.pullRequests?.items ?? []).filter((pr) => pr.isMine));
  } catch (error) {
    console.warn('[work] PR auto-link failed', (error as Error).message);
  }
  res.json(createApiSuccessResponse({
    todos: config.todos ? todosService.list(projectPath) : null,
    links: linksService.list(projectPath),
    ...snapshot,
    slack,
    slackResolved: snapshot.slack ? snapshot.slack.items.filter((m) => resolvedSlack.has(m.id)) : [],
    fetchedAt,
    refreshing,
    /** Items not seen before this load ("slack:<id>", "jira:<key>"); the panel marks them and then calls /seen. */
    newKeys: seenService.unseen(projectPath, currentKeys),
    currentKeys,
  }));
}));

router.post('/todos', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  requireConfig(projectPath);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new AppError('text is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  res.status(201).json(createApiSuccessResponse(todosService.create(projectPath, text.slice(0, 2000))));
}));

router.patch('/todos/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = body.status;
  if (status !== undefined && !['open', 'done', 'cancelled'].includes(status as string)) {
    throw new AppError('status must be open, done or cancelled.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, 2000) : undefined;
  const updated = todosService.update(id, { status: status as TodoStatus | undefined, text });
  if (!updated) throw new AppError('To-do not found.', { code: 'NOT_FOUND', statusCode: 404 });
  res.json(createApiSuccessResponse(updated));
}));

router.delete('/todos/:id', asyncHandler(async (req: Request, res: Response) => {
  if (!todosService.remove(Number(req.params.id))) {
    throw new AppError('To-do not found.', { code: 'NOT_FOUND', statusCode: 404 });
  }
  res.json(createApiSuccessResponse({ deleted: true }));
}));

function readLinkBody(body: Record<string, unknown>): { projectPath: string; itemType: WorkItemType; itemKey: string; sessionId: string } {
  const projectPath = readProjectPath(body.projectPath);
  requireConfig(projectPath);
  const itemType = body.itemType;
  if (itemType !== 'jira' && itemType !== 'todo' && itemType !== 'slack' && itemType !== 'pr') {
    throw new AppError('itemType must be jira, todo, slack or pr.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const itemKey = typeof body.itemKey === 'string' || typeof body.itemKey === 'number' ? String(body.itemKey).trim() : '';
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!itemKey || !sessionId) {
    throw new AppError('itemKey and sessionId are required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  return { projectPath, itemType, itemKey, sessionId };
}

type SessionLinkView = {
  itemType: WorkItemType;
  itemKey: string;
  /** Short chip text, e.g. "GOL-3581", "PR #365", "to-do". */
  label: string;
  title: string;
  url: string | null;
  status: string | null;
  /** True when implied (a PR carrying the Jira key of a linked task) rather than stored. */
  derived: boolean;
};

/** What a session is attached to, resolved for display in its session bar. */
router.get('/session-links', asyncHandler(async (req: Request, res: Response) => {
  const projectPath = readProjectPath(req.query.projectPath);
  const config = requireConfig(projectPath);
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (!sessionId) throw new AppError('sessionId is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const { snapshot } = await getSnapshot(projectPath, config);
  const tasks = snapshot.jira?.items ?? [];
  const prs = snapshot.pullRequests?.items ?? [];
  const mentions = snapshot.slack?.items ?? [];
  const jiraSite = tasks[0]?.url.replace(/\/browse\/.*$/, '') ?? null;
  const workspace = config.bitbucket?.workspace ?? 'thespider';

  try {
    autoLinkPullRequests(projectPath, prs.filter((pr) => pr.isMine));
  } catch {
    /* best effort */
  }

  const views: SessionLinkView[] = [];
  const seen = new Set<string>();
  for (const link of linksService.listForSession(projectPath, sessionId)) {
    const id = `${link.itemType}:${link.itemKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (link.itemType === 'jira') {
      const task = tasks.find((t) => t.key === link.itemKey);
      views.push({
        itemType: 'jira', itemKey: link.itemKey, label: link.itemKey, title: task?.summary ?? link.itemKey,
        url: task?.url ?? (jiraSite ? `${jiraSite}/browse/${link.itemKey}` : null), status: task?.status ?? null, derived: false,
      });
    } else if (link.itemType === 'pr') {
      const [repo, number] = link.itemKey.split('#');
      const pr = prs.find((p) => p.repo === repo && String(p.id) === number);
      views.push({
        itemType: 'pr', itemKey: link.itemKey, label: `PR #${number}`, title: pr ? `${repo}: ${pr.title}` : `${repo} #${number}`,
        url: pr?.url ?? `https://bitbucket.org/${workspace}/${repo}/pull-requests/${number}`, status: pr ? 'open' : 'closed', derived: false,
      });
    } else if (link.itemType === 'todo') {
      const todo = todosService.get(Number(link.itemKey));
      views.push({
        itemType: 'todo', itemKey: link.itemKey, label: 'to-do', title: todo?.text ?? 'Deleted to-do', url: null,
        status: todo?.status ?? null, derived: false,
      });
    } else {
      const mention = mentions.find((m) => m.id === link.itemKey);
      views.push({
        itemType: 'slack', itemKey: link.itemKey, label: mention ? `@${mention.author}` : 'Slack', title: mention?.text.slice(0, 200) ?? 'Slack message',
        url: mention?.permalink ?? null, status: null, derived: false,
      });
    }
  }
  res.json(createApiSuccessResponse({ links: views }));
}));

/** Attaches a chat session to a Jira task or to-do. */
router.post('/links', asyncHandler(async (req: Request, res: Response) => {
  const link = readLinkBody((req.body ?? {}) as Record<string, unknown>);
  linksService.add(link.projectPath, link.itemType, link.itemKey, link.sessionId);
  res.status(201).json(createApiSuccessResponse({ linked: true }));
}));

router.delete('/links', asyncHandler(async (req: Request, res: Response) => {
  const link = readLinkBody((req.body ?? {}) as Record<string, unknown>);
  linksService.remove(link.projectPath, link.itemType, link.itemKey, link.sessionId);
  res.json(createApiSuccessResponse({ linked: false }));
}));

function readSlackId(body: Record<string, unknown>): { projectPath: string; id: string } {
  const projectPath = readProjectPath(body.projectPath);
  const config = requireConfig(projectPath);
  if (!config.slack) throw new AppError('Slack is not set up for this project.', { code: 'WORK_NOT_CONFIGURED', statusCode: 404 });
  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[A-Z0-9]+:\d+\.\d+$/.test(id)) throw new AppError('Invalid Slack message id.', { code: 'INVALID_REQUEST', statusCode: 400 });
  return { projectPath, id };
}

async function slackAction<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new AppError((error as Error).message, { code: 'SLACK_ACTION_FAILED', statusCode: 502 });
  }
}

/** Hides items from the dashboard (or brings them back) without touching Slack or Jira. */
router.post('/resolve', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  requireConfig(projectPath);
  const itemType = body.itemType;
  if (itemType !== 'slack' && itemType !== 'jira' && itemType !== 'todo') {
    throw new AppError('itemType must be slack, jira or todo.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const keys = Array.isArray(body.itemKeys) ? body.itemKeys.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length < 200) : [];
  if (keys.length === 0 || keys.length > 500) throw new AppError('itemKeys is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  resolvedService.set(projectPath, itemType, keys, body.resolved !== false);
  res.json(createApiSuccessResponse({ count: keys.length, resolved: body.resolved !== false }));
}));

/** ✅ a Slack message as the user (or undo it with done=false). */
router.post('/slack/done', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { projectPath, id } = readSlackId(body);
  const secrets = readSecrets();
  await slackAction(() => (body.done === false ? unmarkDone(secrets, id) : markDone(secrets, id)));
  if (body.done === false) {
    markStale(projectPath);
  } else {
    patchSnapshot(projectPath, (snap) => {
      if (snap.slack) snap.slack.items = snap.slack.items.filter((m) => m.id !== id);
    });
  }
  res.json(createApiSuccessResponse({ id, done: body.done !== false }));
}));

/** Drafts a reply in the user's voice for them to edit; nothing is sent. */
router.post('/slack/ai-reply', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { projectPath, id } = readSlackId(body);
  const config = requireConfig(projectPath);
  const threadTs = typeof body.threadTs === 'string' ? body.threadTs : '';
  const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 2000) : '';
  const author = typeof body.author === 'string' ? body.author.slice(0, 100) : 'them';
  const text = await slackAction(async () => draftSlackReply({
    thread: await readThread(readSecrets(), id, threadTs),
    instruction,
    author,
    voiceGuideFile: config.slack?.voiceGuideFile,
    model: config.slack?.replyModel,
  }));
  res.json(createApiSuccessResponse({ text }));
}));

function requireSlack(projectPath: string) {
  const config = requireConfig(projectPath);
  if (!config.slack) throw new AppError('Slack is not set up for this project.', { code: 'WORK_NOT_CONFIGURED', statusCode: 404 });
  return config.slack;
}

/** Compose step 1: understand a plain-words request into recipient, thread options and message text. Nothing is sent. */
router.post('/slack/compose/prepare', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  const slack = requireSlack(projectPath);
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 3000) : '';
  if (!instruction) throw new AppError('Write what to send and to whom.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const preview = await slackAction(() => prepareMessage(readSecrets(), {
    me: slack.userId,
    instruction,
    voiceGuideFile: slack.voiceGuideFile,
    model: slack.replyModel,
  }));
  res.json(createApiSuccessResponse(preview));
}));

/** Compose step 2: save the reviewed message as a Slack draft, or send it as the user. */
router.post('/slack/compose/deliver', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  requireSlack(projectPath);
  const mode = body.mode === 'send' ? 'send' : body.mode === 'draft' ? 'draft' : null;
  const target = body.target as ComposeTarget | undefined;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const threadTs = typeof body.threadTs === 'string' && /^\d+\.\d+$/.test(body.threadTs) ? body.threadTs : null;
  if (!mode || !text || !target || (target.kind !== 'dm' && target.kind !== 'channel') || !/^[A-Z0-9]+$/.test(String(target.id))) {
    throw new AppError('mode, target and text are required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  const result = await slackAction(() => deliverMessage(readSecrets(), { mode, target, threadTs, text: text.slice(0, 4000) }));
  res.json(createApiSuccessResponse({ mode, ...result }));
}));

/** Replies in the message's thread, as the user. */
router.post('/slack/reply', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { projectPath, id } = readSlackId(body);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const threadTs = typeof body.threadTs === 'string' ? body.threadTs : '';
  if (!text) throw new AppError('text is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const result = await slackAction(() => postReply(readSecrets(), id, threadTs, text.slice(0, 4000)));
  patchSnapshot(projectPath, (snap) => {
    if (snap.slack) snap.slack.items = snap.slack.items.filter((m) => m.id !== id);
  });
  res.json(createApiSuccessResponse({ id, ...result }));
}));

/** Moves a Jira issue to another status by name; answers with the status it came from so the UI can undo. */
router.post('/jira/:key/transition', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const projectPath = readProjectPath(body.projectPath);
  const config = requireConfig(projectPath);
  if (!config.jira) throw new AppError('Jira is not set up for this project.', { code: 'WORK_NOT_CONFIGURED', statusCode: 404 });
  const to = typeof body.to === 'string' ? body.to : '';
  if (!to) throw new AppError('to is required.', { code: 'INVALID_REQUEST', statusCode: 400 });
  const key = String(req.params.key).toUpperCase();
  if (!key.startsWith(`${config.jira.projectKey}-`)) {
    throw new AppError(`Only ${config.jira.projectKey} issues can be moved here.`, { code: 'INVALID_REQUEST', statusCode: 400 });
  }
  try {
    const result = await transitionIssue(readSecrets(), key, to);
    patchSnapshot(projectPath, (snap) => {
      const task = snap.jira?.items.find((t) => t.key === key);
      if (task) {
        task.status = result.to;
        task.updated = new Date().toISOString();
      }
    });
    res.json(createApiSuccessResponse({ key, ...result }));
  } catch (error) {
    throw new AppError((error as Error).message, { code: 'JIRA_TRANSITION_FAILED', statusCode: 502 });
  }
}));

export default router;
